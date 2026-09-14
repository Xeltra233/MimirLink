package tts

import (
	"context"
	"encoding/base64"

	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// ---------- 帧编解码 ----------

func TestBuildAndParseFrameRoundtrip(t *testing.T) {
	payload := []byte(`{"ok":true}`)
	raw := buildFrame(msgTypeFullClientRequest, flagHasEvent, serializationJSON, 0, eventStartSession, "session-1", payload)
	if raw[0] != 0x11 {
		t.Fatalf("协议版本/头大小错误: %#x", raw[0])
	}
	if raw[1] != msgTypeFullClientRequest<<4|flagHasEvent {
		t.Fatalf("消息类型错误: %#x", raw[1])
	}
	f := parseFrame(raw)
	if f.isError {
		t.Fatalf("不应解析为错误帧")
	}
	if f.event != eventStartSession {
		t.Fatalf("event = %d, want %d", f.event, eventStartSession)
	}
	if f.sessionID != "session-1" {
		t.Fatalf("sessionID = %q", f.sessionID)
	}
	if string(f.payload) != string(payload) {
		t.Fatalf("payload = %q", f.payload)
	}
}

func TestParseErrorFrame(t *testing.T) {
	// 构造错误帧: header + event + error_code + payload
	header := []byte{0x11, msgTypeError<<4 | flagHasEvent, 0x00, 0x00}
	event := []byte{0, 0, 0, 51} // ConnectionFailed
	code := []byte{0, 0, 0, 7}
	msg := []byte(`{"message":"bad key"}`)
	lenBuf := []byte{0, 0, 0, byte(len(msg))}
	raw := append(append(append(append(header, event...), code...), lenBuf...), msg...)
	f := parseFrame(raw)
	if !f.isError {
		t.Fatalf("应解析为错误帧")
	}
	if f.errorCode != 7 {
		t.Fatalf("errorCode = %d", f.errorCode)
	}
	if !strings.Contains(f.errorText, "bad key") {
		t.Fatalf("errorText = %q", f.errorText)
	}
}

// ---------- HTTP provider（mock 上游验证请求形状与音频解码） ----------

func TestSynthesizeMinimaxMock(t *testing.T) {
	audio := []byte("fake-mp3-bytes")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/t2a_v2" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
			t.Errorf("Authorization = %q", auth)
		}
		var body struct {
			Model        string `json:"model"`
			Text         string `json:"text"`
			VoiceSetting struct {
				VoiceID string  `json:"voice_id"`
				Speed   float64 `json:"speed"`
			} `json:"voice_setting"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "speech-2.8-hd" || body.Text != "你好" || body.VoiceSetting.VoiceID != "male-qn-badao" {
			t.Errorf("请求体不符合预期: %+v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"base_resp": map[string]any{"status_code": 0},
			"data":      map[string]any{"audio": hexEncode(audio)},
		})
	}))
	defer server.Close()

	manager := NewWithAudioDir(t.TempDir(), nil)
	manager.UpdateConfig(map[string]any{
		"enabled": true, "provider": "minimax", "apiKey": "test-key",
		"modelId": "speech-2.8-hd", "voiceId": "male-qn-badao", "encoding": "mp3",
		"baseUrl": server.URL, "speed": 1.1,
	})
	path, err := manager.Synthesize(context.Background(), "你好")
	if err != nil {
		t.Fatalf("合成失败: %v", err)
	}
	assertAudioFile(t, manager, path, audio)
}

func TestSynthesizeQwenMock(t *testing.T) {
	audio := []byte("fake-wav-bytes")
	var serverURL string
	generation := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/services/aigc/multimodal-generation/generation" {
			t.Errorf("path = %s", r.URL.Path)
		}
		var body struct {
			Model string `json:"model"`
			Input struct {
				Text  string `json:"text"`
				Voice string `json:"voice"`
			} `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "qwen3-tts-flash" || body.Input.Voice != "Cherry" {
			t.Errorf("请求体不符合预期: %+v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status_code": 200,
			"output": map[string]any{
				"audio": map[string]any{"url": serverURL + "/audio.wav", "data": ""},
			},
		})
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/services/aigc/multimodal-generation/generation", generation)
	mux.HandleFunc("/audio.wav", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(audio)
	})
	server := httptest.NewServer(mux)
	serverURL = server.URL
	defer server.Close()

	manager := NewWithAudioDir(t.TempDir(), nil)
	manager.UpdateConfig(map[string]any{
		"enabled": true, "provider": "qwen", "apiKey": "sk-test",
		"modelId": "qwen3-tts-flash", "voiceId": "Cherry", "encoding": "wav",
		"baseUrl": server.URL, "languageType": "Chinese",
	})
	path, err := manager.Synthesize(context.Background(), "你好世界")
	if err != nil {
		t.Fatalf("合成失败: %v", err)
	}
	assertAudioFile(t, manager, path, audio)
}

func TestSynthesizeMimoMock(t *testing.T) {
	audio := []byte("fake-wav-mimo")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
			Audio struct {
				Format string `json:"format"`
				Voice  string `json:"voice"`
			} `json:"audio"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "mimo-v2.5-tts" || body.Audio.Voice != "冰糖" || body.Audio.Format != "wav" {
			t.Errorf("请求体不符合预期: %+v", body)
		}
		// user=风格指令（可选），assistant=合成文本
		if len(body.Messages) != 2 || body.Messages[0].Role != "user" || body.Messages[1].Role != "assistant" {
			t.Errorf("messages 不符合预期: %+v", body.Messages)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{
					"audio": map[string]any{"data": base64.StdEncoding.EncodeToString(audio)},
				},
			}},
		})
	}))
	defer server.Close()

	manager := NewWithAudioDir(t.TempDir(), nil)
	manager.UpdateConfig(map[string]any{
		"enabled": true, "provider": "mimo", "apiKey": "mk-test",
		"modelId": "mimo-v2.5-tts", "voiceId": "冰糖", "encoding": "wav",
		"baseUrl": server.URL, "styleInstruction": "用轻快的语调",
	})
	path, err := manager.Synthesize(context.Background(), "今天天气不错")
	if err != nil {
		t.Fatalf("合成失败: %v", err)
	}
	assertAudioFile(t, manager, path, audio)
}

func TestValidateConfigMissingFields(t *testing.T) {
	manager := NewWithAudioDir(t.TempDir(), nil)
	if err := manager.ValidateConfig(); err == nil {
		t.Fatal("未启用时应报错")
	}
	manager.UpdateConfig(map[string]any{"enabled": true, "provider": "qwen", "apiKey": "k", "voiceId": "Cherry"})
	if err := manager.ValidateConfig(); err == nil || !strings.Contains(err.Error(), "模型 ID") {
		t.Fatalf("qwen 缺模型应报错: %v", err)
	}
	manager.UpdateConfig(map[string]any{"enabled": true, "provider": "unsupported"})
	if err := manager.ValidateConfig(); err == nil {
		t.Fatal("未知供应商应报错")
	}
}

func TestVoicesForProvider(t *testing.T) {
	if got := VoicesForProvider("qwen"); len(got) < 40 {
		t.Fatalf("qwen 音色数异常: %d", len(got))
	}
	if got := VoicesForProvider("mimo"); len(got) != 9 {
		t.Fatalf("mimo 音色数 = %d, want 9", len(got))
	}
	if got := VoicesForProvider("minimax"); len(got) < 8 {
		t.Fatalf("minimax 音色数异常: %d", len(got))
	}
	if got := VoicesForProvider("doubao"); len(got) == 0 {
		t.Fatal("doubao 音色为空")
	}
}

// ---------- 辅助 ----------

func hexEncode(data []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(data)*2)
	for _, b := range data {
		out = append(out, digits[b>>4], digits[b&0x0F])
	}
	return string(out)
}

func assertAudioFile(t *testing.T, manager *Manager, path string, want []byte) {
	t.Helper()
	if path == "" {
		t.Fatal("路径为空")
	}
	got, err := osReadFile(path)
	if err != nil {
		t.Fatalf("读取音频失败: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("音频内容不一致: got %d bytes want %d bytes", len(got), len(want))
	}
}

func osReadFile(path string) ([]byte, error) { return os.ReadFile(path) }

// ---------- doubao WebSocket 协议（mock 服务端走完整握手序列） ----------

func TestSynthesizeDoubaoMockWS(t *testing.T) {
	upgrader := websocket.Upgrader{}
	audio := []byte("fake-doubao-mp3")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-App-Key") != "app-1" || r.Header.Get("X-Api-Access-Key") != "key-1" {
			t.Errorf("鉴权头缺失: %v", r.Header)
		}
		if r.Header.Get("X-Api-Resource-Id") != "seed-tts-2.0" {
			t.Errorf("Resource-Id = %q", r.Header.Get("X-Api-Resource-Id"))
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var clientSessionID string
		expect := func(wantEvent int32) map[string]any {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				t.Errorf("读帧失败: %v", err)
				return nil
			}
			f := parseFrame(raw)
			if f.sessionID != "" {
				clientSessionID = f.sessionID
			}
			if f.event != wantEvent {
				t.Errorf("event = %d, want %d", f.event, wantEvent)
			}
			var payload map[string]any
			if len(f.payload) > 0 {
				_ = json.Unmarshal(f.payload, &payload)
			}
			return payload
		}
		send := func(event int32, payload any) {
			encoded, _ := json.Marshal(payload)
			_ = conn.WriteMessage(websocket.BinaryMessage,
				buildFrame(msgTypeFullServerResponse, flagHasEvent, serializationJSON, 0, event, "", encoded))
		}
		expect(eventStartConnection)
		send(eventConnectionStarted, map[string]any{})
		startSession := expect(eventStartSession)
		if startSession == nil || startSession["namespace"] != "BidirectionalTTS" {
			t.Errorf("StartSession 载荷异常: %v", startSession)
		}
		send(eventSessionStarted, map[string]any{})
		task := expect(eventTaskRequest)
		if task == nil {
			t.Fatal("缺少 TaskRequest")
		}
		reqParams, _ := task["req_params"].(map[string]any)
		if reqParams["text"] != "你好" || reqParams["speaker"] != "zh_female_demo" {
			t.Errorf("TaskRequest 参数异常: %v", reqParams)
		}
		expect(eventFinishSession)
		// 音频帧: 带会话 ID + 二进制载荷（serialization=0，与真实服务端一致）
		audioFrame := buildFrame(msgTypeFullServerResponse, flagHasEvent, 0, 0, eventTTSResponse, clientSessionID, audio)
		_ = conn.WriteMessage(websocket.BinaryMessage, audioFrame)
		send(eventSessionFinished, map[string]any{})
		expect(eventFinishConnection)
		send(eventConnectionFinished, map[string]any{})
	}))
	// 把 http:// 转成 ws:// 交给 BaseURL
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	defer server.Close()

	manager := NewWithAudioDir(t.TempDir(), nil)
	manager.UpdateConfig(map[string]any{
		"enabled": true, "provider": "doubao", "appId": "app-1", "apiKey": "key-1",
		"voiceId": "zh_female_demo", "encoding": "mp3", "baseUrl": wsURL,
	})
	path, err := manager.Synthesize(context.Background(), "你好")
	if err != nil {
		t.Fatalf("合成失败: %v", err)
	}
	assertAudioFile(t, manager, path, audio)
}
