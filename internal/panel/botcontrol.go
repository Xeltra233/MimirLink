package panel

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"mimirlink/internal/botctl"
)

// 本文件实现面板 → bot 进程的控制通道调用。
// 面板自身没有 OneBot 连接与 AI 客户端，凡是必须由 bot 执行的动作
// （主动 @ 测试、立即增量分析、刷新用户名、OneBot 重连）都转发给 bot，
// bot 未运行时返回可读的指引而不是假成功。

const controlTimeout = 60 * time.Second

// botControlEndpoint 读取发现文件，返回控制地址与令牌。
func (s *Server) botControlEndpoint() (botctl.ControlFile, string, error) {
	control, err := botctl.ReadControlFile(s.dataDir)
	if err != nil {
		return botctl.ControlFile{}, "", err
	}
	return control, fmt.Sprintf("http://127.0.0.1:%d", control.Port), nil
}

// callBotControl 调用 bot 控制接口。第二个返回值是可读错误（bot 未运行时给出指引）。
func (s *Server) callBotControl(path string, payload map[string]any) (map[string]any, error) {
	control, baseURL, err := s.botControlEndpoint()
	if err != nil {
		return nil, fmt.Errorf("Bot 进程未运行或控制接口不可用（%v）：该动作需要 Bot 在线（请先用 -bot 启动）", err)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Bot-Token", control.Token)
	client := &http.Client{Timeout: controlTimeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("调用 Bot 控制接口失败: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("读取 Bot 响应失败: %w", err)
	}
	result := map[string]any{}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("Bot 响应不是合法 JSON: %s", strings.TrimSpace(string(raw)))
	}
	if response.StatusCode != http.StatusOK {
		return result, fmt.Errorf("Bot 返回 %d: %v", response.StatusCode, result["error"])
	}
	if result["success"] == false {
		return result, fmt.Errorf("%v", orDefault(fmt.Sprint(result["error"]), "Bot 执行失败"))
	}
	return result, nil
}

// botStatusSnapshot 返回 bot 状态（不可用时返回 nil）。
func (s *Server) botStatusSnapshot() map[string]any {
	control, baseURL, err := s.botControlEndpoint()
	if err != nil {
		return nil
	}
	request, err := http.NewRequest(http.MethodGet, baseURL+"/control/status", nil)
	if err != nil {
		return nil
	}
	request.Header.Set("X-Bot-Token", control.Token)
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil
	}
	defer func() { _ = response.Body.Close() }()
	result := map[string]any{}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return nil
	}
	return result
}

// onebotStatusPayload 组装面板状态里的 OneBot 段：
// 优先取 Bot 控制口的真实连接状态，Bot 未运行时回退配置值与提示语。
func (s *Server) onebotStatusPayload() map[string]any {
	return s.onebotStatusPayloadFrom(s.botStatusSnapshot())
}

// onebotStatusPayloadFrom 用已获取的 bot 状态快照组装 OneBot 段（避免重复调用控制口）。
func (s *Server) onebotStatusPayloadFrom(status map[string]any) map[string]any {
	payload := map[string]any{
		"connected": false,
		"url":       s.document.String("onebot.url"),
		"mode":      orDefault(s.document.String("onebot.mode"), "ws"),
		"tokenMode": orDefault(s.document.String("onebot.tokenMode"), "header"),
		"hasToken":  strings.TrimSpace(s.document.String("onebot.accessToken")) != "",
		"selfId":    "",
		"nickname":  "",
	}
	if status == nil {
		payload["note"] = "Bot 进程未运行（连接状态由 Bot 提供，请用 -bot 启动或在同进程加 -serve 共用）"
		return payload
	}
	copyText := func(key string, source map[string]any, from string) {
		value := strings.TrimSpace(fmt.Sprintf("%v", source[from]))
		if value != "" && value != "<nil>" {
			payload[key] = value
		}
	}
	if connected, ok := status["connected"].(bool); ok {
		payload["connected"] = connected
	}
	for _, pair := range [][2]string{{"selfId", "selfId"}, {"nickname", "nickname"}, {"url", "url"}, {"mode", "mode"}, {"tokenMode", "tokenMode"}} {
		copyText(pair[0], status, pair[1])
	}
	if hasToken, ok := status["hasToken"].(bool); ok {
		payload["hasToken"] = hasToken
	}
	return payload
}
