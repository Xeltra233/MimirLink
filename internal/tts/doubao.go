package tts

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// 火山引擎 seed-tts 双向流式 WebSocket 二进制协议。
// 协议参考: https://www.volcengine.com/docs/6561/1329505

// 事件号（与 Node 版 Events 常量一致）。
const (
	eventStartConnection    = 1
	eventFinishConnection   = 2
	eventStartSession       = 100
	eventFinishSession      = 102
	eventTaskRequest        = 200
	eventConnectionStarted  = 50
	eventConnectionFailed   = 51
	eventConnectionFinished = 52
	eventSessionStarted     = 150
	eventSessionFailed      = 153
	eventSessionFinished    = 152
	eventTTSResponse        = 352
)

// 消息类型与标志位。
const (
	msgTypeFullClientRequest  = 0x01
	msgTypeFullServerResponse = 0x09
	msgTypeError              = 0x0F
	flagHasEvent              = 0x04
	flagHasSequence           = 0x01
	serializationJSON         = 0x01
)

// frame 是解析后的下行帧。
type frame struct {
	messageType   byte
	flags         byte
	serialization byte
	event         int32
	sessionID     string
	payload       []byte // JSON 时为原始字节，音频时为二进制
	isError       bool
	errorCode     int32
	errorText     string
}

// buildFrame 构建上行二进制帧（对应 Node buildFrame）。
func buildFrame(messageType, flags, serialization, compression byte, event int32, sessionID string, payload []byte) []byte {
	header := []byte{0x11, messageType<<4 | flags, serialization<<4 | compression, 0x00}
	parts := [][]byte{header}
	if flags&flagHasEvent != 0 {
		eventBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(eventBuf, uint32(event))
		parts = append(parts, eventBuf)
	}
	if sessionID != "" {
		sessionBuf := []byte(sessionID)
		lenBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(lenBuf, uint32(len(sessionBuf)))
		parts = append(parts, lenBuf, sessionBuf)
	}
	if payload != nil {
		lenBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(lenBuf, uint32(len(payload)))
		parts = append(parts, lenBuf, payload)
	}
	size := 0
	for _, part := range parts {
		size += len(part)
	}
	out := make([]byte, 0, size)
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

// parseFrame 解析下行二进制帧（对应 Node parseFrame）。
func parseFrame(data []byte) frame {
	result := frame{}
	if len(data) < 4 {
		result.isError = true
		result.errorText = "帧过短"
		return result
	}
	headerSize := int(data[0]&0x0F) * 4
	result.messageType = (data[1] >> 4) & 0x0F
	result.flags = data[1] & 0x0F
	result.serialization = (data[2] >> 4) & 0x0F
	offset := headerSize

	hasEvent := result.flags&flagHasEvent != 0
	if hasEvent && offset+4 <= len(data) {
		result.event = int32(binary.BigEndian.Uint32(data[offset:]))
		offset += 4
	}

	// 错误帧: messageType 0x0F，格式 header + error_code + payload
	if result.messageType == msgTypeError {
		result.isError = true
		if offset+4 <= len(data) {
			result.errorCode = int32(binary.BigEndian.Uint32(data[offset:]))
			offset += 4
		}
		if offset+4 <= len(data) {
			payloadLen := int(binary.BigEndian.Uint32(data[offset:]))
			offset += 4
			if payloadLen > 0 && offset+payloadLen <= len(data) {
				result.errorText = strings.TrimSpace(string(data[offset : offset+payloadLen]))
			}
		}
		return result
	}

	hasSequence := result.flags&flagHasSequence != 0
	if hasSequence && offset+4 <= len(data) {
		offset += 4
	}
	if result.event >= 100 && offset+4 <= len(data) {
		sessionLen := int(binary.BigEndian.Uint32(data[offset:]))
		offset += 4
		if sessionLen > 0 && sessionLen < 100 && offset+sessionLen <= len(data) {
			result.sessionID = string(data[offset : offset+sessionLen])
			offset += sessionLen
		}
	}
	if offset+4 <= len(data) {
		payloadLen := int(binary.BigEndian.Uint32(data[offset:]))
		offset += 4
		if payloadLen > 0 && offset+payloadLen <= len(data) {
			result.payload = data[offset : offset+payloadLen]
		}
	}
	return result
}

// requestPayload 是会话/任务请求的 JSON 结构。
type requestPayload struct {
	User struct {
		UID string `json:"uid"`
	} `json:"user"`
	Event     int32          `json:"event"`
	Namespace string         `json:"namespace"`
	ReqParams map[string]any `json:"req_params"`
}

func newRequestPayload(event int32, reqParams map[string]any) requestPayload {
	payload := requestPayload{Event: event, Namespace: "BidirectionalTTS", ReqParams: reqParams}
	payload.User.UID = "mimirlink-user"
	return payload
}

// synthesizeDoubao 走火山 seed-tts-2.0 双向 WebSocket 协议。
func (m *Manager) synthesizeDoubao(ctx context.Context, text string) (string, error) {
	endpoint := doubaoDefaultEndpoint
	if m.config.BaseURL != "" {
		candidate := strings.Replace(strings.TrimSuffix(m.config.BaseURL, "/"), "http://", "ws://", 1)
		candidate = strings.Replace(candidate, "https://", "wss://", 1)
		if strings.HasPrefix(candidate, "ws") {
			endpoint = candidate
		}
	}
	dialCtx, dialCancel := context.WithTimeout(ctx, 15*time.Second)
	defer dialCancel()
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	header := http.Header{}
	header.Set("X-Api-App-Key", m.config.AppID)
	header.Set("X-Api-Access-Key", m.config.APIKey)
	header.Set("X-Api-Resource-Id", "seed-tts-2.0")
	connectID := uuid.NewString()
	header.Set("X-Api-Connect-Id", connectID)
	conn, _, err := dialer.DialContext(dialCtx, endpoint, header)
	if err != nil {
		return "", fmt.Errorf("TTS 连接失败: %w", err)
	}
	defer conn.Close()

	audioChunks := [][]byte{}
	sessionID := uuid.NewString()
	done := make(chan error, 1)
	go func() {
		<-ctx.Done()
		_ = conn.Close()
		done <- ctx.Err()
	}()
	finished := make(chan error, 1)
	var resultPath string
	setResult := func(path string, err error) {
		resultPath = path
		finished <- err
	}
	go func() {
		defer close(finished)
		// 1. StartConnection
		if err := conn.WriteMessage(websocket.BinaryMessage,
			buildFrame(msgTypeFullClientRequest, flagHasEvent, serializationJSON, 0, eventStartConnection, "", []byte("{}"))); err != nil {
			finished <- fmt.Errorf("发送 StartConnection 失败: %w", err)
			return
		}
		sessionRequested := false
		taskRequested := false
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				select {
				case <-ctx.Done():
					finished <- ctx.Err()
				default:
					finished <- fmt.Errorf("TTS 读取失败: %w", err)
				}
				return
			}
			f := parseFrame(raw)
			if f.isError {
				finished <- fmt.Errorf("TTS 错误: %s (code=%d)", fallbackText(f.errorText, "unknown"), f.errorCode)
				return
			}
			switch f.event {
			case eventConnectionStarted:
				payload := newRequestPayload(eventStartSession, map[string]any{
					"text":    "",
					"speaker": m.config.VoiceID,
					"audio_params": map[string]any{
						"format":      m.config.Encoding,
						"sample_rate": 24000,
					},
				})
				encoded, _ := json.Marshal(payload)
				if err := conn.WriteMessage(websocket.BinaryMessage,
					buildFrame(msgTypeFullClientRequest, flagHasEvent, serializationJSON, 0, eventStartSession, sessionID, encoded)); err != nil {
					finished <- fmt.Errorf("发送 StartSession 失败: %w", err)
					return
				}
				sessionRequested = true
			case eventSessionStarted:
				speechRate := int64((m.config.Speed - 1) * 100)
				loudnessRate := int64((m.config.Volume - 1) * 100)
				payload := newRequestPayload(eventTaskRequest, map[string]any{
					"text":    text,
					"speaker": m.config.VoiceID,
					"audio_params": map[string]any{
						"format":        m.config.Encoding,
						"sample_rate":   24000,
						"speech_rate":   speechRate,
						"loudness_rate": loudnessRate,
					},
				})
				encoded, _ := json.Marshal(payload)
				if err := conn.WriteMessage(websocket.BinaryMessage,
					buildFrame(msgTypeFullClientRequest, flagHasEvent, serializationJSON, 0, eventTaskRequest, sessionID, encoded)); err != nil {
					finished <- fmt.Errorf("发送 TaskRequest 失败: %w", err)
					return
				}
				if err := conn.WriteMessage(websocket.BinaryMessage,
					buildFrame(msgTypeFullClientRequest, flagHasEvent, serializationJSON, 0, eventFinishSession, sessionID, []byte("{}"))); err != nil {
					finished <- fmt.Errorf("发送 FinishSession 失败: %w", err)
					return
				}
				taskRequested = true
			case eventTTSResponse:
				if len(f.payload) > 0 {
					if f.serialization == serializationJSON {
						// JSON 载荷内可能带 base64 data 字段
						var wrapper struct {
							Data string `json:"data"`
						}
						if json.Unmarshal(f.payload, &wrapper) == nil && wrapper.Data != "" {
							if decoded, err := decodeBase64(wrapper.Data); err == nil {
								audioChunks = append(audioChunks, decoded)
							}
						}
					} else {
						chunk := make([]byte, len(f.payload))
						copy(chunk, f.payload)
						audioChunks = append(audioChunks, chunk)
					}
				}
			case eventSessionFinished:
				if !taskRequested {
					finished <- fmt.Errorf("TTS 会话在合成前结束")
					return
				}
				_ = conn.WriteMessage(websocket.BinaryMessage,
					buildFrame(msgTypeFullClientRequest, flagHasEvent, serializationJSON, 0, eventFinishConnection, "", []byte("{}")))
			case eventConnectionFinished:
				if !sessionRequested {
					finished <- fmt.Errorf("TTS 连接在会话开始前结束")
					return
				}
				if len(audioChunks) == 0 {
					finished <- fmt.Errorf("TTS 未返回音频数据")
					return
				}
				total := 0
				for _, chunk := range audioChunks {
					total += len(chunk)
				}
				audio := make([]byte, 0, total)
				for _, chunk := range audioChunks {
					audio = append(audio, chunk...)
				}
				path, err := m.writeAudioFile(audio)
				if err != nil {
					setResult("", err)
					return
				}
				setResult(path, nil)
				return
			case eventConnectionFailed, eventSessionFailed:
				finished <- fmt.Errorf("TTS 会话失败: %s", describeJSONPayload(f.payload))
				return
			}
		}
	}()

	timeout := time.NewTimer(30 * time.Second)
	defer timeout.Stop()
	select {
	case err := <-finished:
		if err != nil {
			return "", err
		}
		return resultPath, nil
	case err := <-done:
		return "", fmt.Errorf("TTS 请求取消: %w", err)
	case <-timeout.C:
		_ = conn.Close()
		return "", fmt.Errorf("TTS 请求超时")
	}
}

func fallbackText(value, placeholder string) string {
	if strings.TrimSpace(value) == "" {
		return placeholder
	}
	return value
}

func describeJSONPayload(payload []byte) string {
	if len(payload) == 0 {
		return "unknown"
	}
	var wrapper struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(payload, &wrapper) == nil && wrapper.Message != "" {
		return wrapper.Message
	}
	return string(payload)
}
