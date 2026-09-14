package panel

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"mimirlink/internal/mcp"
)

// 本文件补齐 MCP 管理路由（对齐 Node 版 /api/mcp/*）：
// status / settings / servers 增删 / reconnect / import（JSON 导入）/ call。

const mcpSecretMask = "******"

var httpURLPattern = regexp.MustCompile(`^https?://\S+$`)

func (s *Server) registerMCPRoutes() {
	s.mux.HandleFunc("/api/mcp/status", s.requireAuth(s.handleMCPStatus))
	s.mux.HandleFunc("/api/mcp/settings", s.requireAuth(s.handleMCPSettings))
	s.mux.HandleFunc("/api/mcp/servers", s.requireAuth(s.handleMCPServers))
	s.mux.HandleFunc("/api/mcp/servers/", s.requireAuth(s.handleMCPServerDetail))
	s.mux.HandleFunc("/api/mcp/import", s.requireAuth(s.handleMCPImport))
	s.mux.HandleFunc("/api/mcp/call", s.requireAuth(s.handleMCPCall))
}

// loadMCPSection 读取配置中的 mcp 段（map 形式）。
func (s *Server) loadMCPSection() map[string]any {
	var raw map[string]any
	if err := json.Unmarshal(s.document.Raw(), &raw); err != nil {
		return map[string]any{}
	}
	section, _ := raw["mcp"].(map[string]any)
	if section == nil {
		return map[string]any{}
	}
	return section
}

// writeMCPSection 写回 mcp 段并保存配置，然后热重载客户端（如有）。
func (s *Server) writeMCPSection(section map[string]any) ([]mcp.ServerStatus, error) {
	if err := s.document.Set("mcp", section); err != nil {
		return nil, err
	}
	if err := s.document.Save(); err != nil {
		return nil, err
	}
	sectionJSON, _ := json.Marshal(section)
	var raw map[string]any
	_ = json.Unmarshal(sectionJSON, &raw)
	config := mcp.LoadConfig(raw)
	if s.mcpClient == nil {
		// 面板启动时无 MCP 客户端（如启动时未启用），按需创建并连接
		client := mcp.New(config, s.logger)
		client.ConnectAll(requestContext())
		s.mcpClient = client
		return client.Status(), nil
	}
	return s.mcpClient.Reload(config), nil
}

// requestContext 面板内部操作的后台上下文。
func requestContext() context.Context { return context.Background() }

// clientStatusPayload 返回客户端状态（与 Node getMcpClientStatus 一致：运行态优先）。
func (s *Server) clientStatusPayload() []mcp.ServerStatus {
	if s.mcpClient != nil {
		return s.mcpClient.Status()
	}
	section := s.loadMCPSection()
	sectionJSON, _ := json.Marshal(section)
	var raw map[string]any
	_ = json.Unmarshal(sectionJSON, &raw)
	config := mcp.LoadConfig(raw)
	statuses := make([]mcp.ServerStatus, 0, len(config.Servers))
	for _, server := range config.Servers {
		statuses = append(statuses, mcp.ServerStatus{
			ID: server.ID, Name: server.Name, Enabled: server.Enabled,
			Transport: server.Transport, Command: server.Command, URL: server.URL,
		})
	}
	return statuses
}

func maskSecretMap(values map[string]string) map[string]string {
	masked := map[string]string{}
	for key, value := range values {
		if strings.TrimSpace(value) != "" {
			masked[key] = mcpSecretMask
		}
	}
	return masked
}

func hasSecret(values map[string]string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// mergeSecrets 对齐 Node mergeMcpSecrets：值为 '******' 时沿用旧值；缺失键视为删除。
func mergeSecrets(next map[string]string, existing map[string]string) map[string]string {
	merged := map[string]string{}
	for key, value := range next {
		if value == mcpSecretMask {
			if oldValue, ok := existing[key]; ok {
				merged[key] = oldValue
			}
			continue
		}
		merged[key] = value
	}
	return merged
}

// maskedServerPayload 归一化后的 server 打上密钥掩码。
func maskedServerPayload(server mcp.ServerConfig) map[string]any {
	encoded, _ := json.Marshal(server)
	var payload map[string]any
	_ = json.Unmarshal(encoded, &payload)
	payload["env"] = maskSecretMap(server.Env)
	payload["headers"] = maskSecretMap(server.Headers)
	payload["hasEnv"] = hasSecret(server.Env)
	payload["hasHeaders"] = hasSecret(server.Headers)
	return payload
}

func (s *Server) handleMCPStatus(writer http.ResponseWriter, request *http.Request) {
	section := s.loadMCPSection()
	enabled := section["enabled"] != false
	path, _ := section["path"].(string)
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true,
		"server":  map[string]any{"enabled": enabled, "path": orDefault(path, "/mcp")},
		"client":  s.clientStatusPayload(),
	})
}

func (s *Server) handleMCPSettings(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	section := s.loadMCPSection()
	client, _ := section["client"].(map[string]any)
	if client == nil {
		client = map[string]any{}
	}
	if enabled, ok := body["enabled"].(bool); ok {
		client["enabled"] = enabled
	}
	if maxChars, ok := body["maxResultChars"].(float64); ok && maxChars >= 500 && maxChars <= 50000 {
		client["maxResultChars"] = int(maxChars)
	}
	section["client"] = client
	status, err := s.writeMCPSection(section)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "client": status})
}

// normalizeServerFromPayload 兼容 Claude Desktop / .mcp.json 的 type/command/url 推导。
func normalizeServerFromPayload(payload map[string]any) (mcp.ServerConfig, bool) {
	source := map[string]any{}
	for key, value := range payload {
		source[key] = value
	}
	if transport, _ := source["transport"].(string); strings.TrimSpace(transport) == "" {
		if typeName, _ := source["type"].(string); strings.TrimSpace(typeName) != "" {
			source["transport"] = typeName
		} else if command, _ := source["command"].(string); strings.TrimSpace(command) != "" {
			source["transport"] = "stdio"
		} else if url, _ := source["url"].(string); strings.TrimSpace(url) != "" {
			source["transport"] = "http"
		}
	}
	return mcp.NormalizeServerConfig(source)
}

func stringMapOfAny(value any) map[string]string {
	result := map[string]string{}
	if entries, ok := value.(map[string]any); ok {
		for key, item := range entries {
			if text, ok := item.(string); ok {
				result[key] = text
			}
		}
	}
	return result
}

func (s *Server) handleMCPServers(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var payload map[string]any
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	section := s.loadMCPSection()
	client, _ := section["client"].(map[string]any)
	if client == nil {
		client = map[string]any{"enabled": false}
	}
	existingServers := decodeServers(client["servers"])

	// 找到旧配置（按 id）
	providedID, _ := payload["id"].(string)
	var existing *mcp.ServerConfig
	for index := range existingServers {
		if existingServers[index].ID == providedID && providedID != "" {
			existing = &existingServers[index]
			break
		}
	}
	if existing != nil {
		payload["id"] = existing.ID
	}
	normalized, ok := normalizeServerFromPayload(payload)
	if !ok {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "服务器名称不能为空"})
		return
	}
	for _, server := range existingServers {
		if server.Name == normalized.Name && server.ID != normalized.ID {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "服务器名称已存在: " + normalized.Name})
			return
		}
	}
	if normalized.Transport == "stdio" && normalized.Command == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "stdio 传输必须提供 command"})
		return
	}
	if normalized.Transport != "stdio" && !httpURLPattern.MatchString(normalized.URL) {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "http/sse 传输必须提供合法的 http(s) URL"})
		return
	}
	if existing != nil {
		normalized.Env = mergeSecrets(stringMapOfAny(payload["env"]), existing.Env)
		normalized.Headers = mergeSecrets(stringMapOfAny(payload["headers"]), existing.Headers)
	}

	replaced := false
	for index := range existingServers {
		if existingServers[index].ID == normalized.ID {
			existingServers[index] = normalized
			replaced = true
			break
		}
	}
	if !replaced {
		existingServers = append(existingServers, normalized)
	}
	client["servers"] = encodeServers(existingServers)
	section["client"] = client
	status, err := s.writeMCPSection(section)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	var serverStatus *mcp.ServerStatus
	for index := range status {
		if status[index].ID == normalized.ID {
			serverStatus = &status[index]
			break
		}
	}
	if serverStatus != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "server": serverStatus, "client": status})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "server": mcp.MaskedServerConfig(normalized), "client": status})
}

// handleMCPServerDetail 处理 DELETE /api/mcp/servers/:id 与 POST /api/mcp/servers/:id/reconnect。
func (s *Server) handleMCPServerDetail(writer http.ResponseWriter, request *http.Request) {
	serverID := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/mcp/servers/"), "/")
	if serverID == "" {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "缺少服务器 ID"})
		return
	}
	if strings.HasSuffix(serverID, "/reconnect") {
		s.handleMCPReconnect(writer, strings.TrimSuffix(serverID, "/reconnect"))
		return
	}
	if request.Method != http.MethodDelete {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	section := s.loadMCPSection()
	client, _ := section["client"].(map[string]any)
	if client == nil {
		client = map[string]any{}
	}
	existingServers := decodeServers(client["servers"])
	remaining := existingServers[:0:0]
	found := false
	for _, server := range existingServers {
		if server.ID == serverID {
			found = true
			continue
		}
		remaining = append(remaining, server)
	}
	if !found {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "服务器不存在"})
		return
	}
	client["servers"] = encodeServers(remaining)
	section["client"] = client
	status, err := s.writeMCPSection(section)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "client": status})
}

func (s *Server) handleMCPReconnect(writer http.ResponseWriter, serverID string) {
	if s.mcpClient == nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"success": false, "error": "MCP 客户端未初始化"})
		return
	}
	if err := s.mcpClient.Reconnect(serverID); err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": err.Error(), "client": s.clientStatusPayload()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "ok": true, "client": s.clientStatusPayload()})
}

// handleMCPImport JSON 导入（兼容数组 / {mcpServers:{}} / {servers:[]} / 单对象）。
func (s *Server) handleMCPImport(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	rawText, _ := body["json"].(string)
	rawText = strings.TrimSpace(rawText)
	if rawText == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "JSON 内容不能为空"})
		return
	}
	var parsed any
	if err := json.Unmarshal([]byte(rawText), &parsed); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "JSON 解析失败: " + err.Error()})
		return
	}
	entries := []any{}
	switch typed := parsed.(type) {
	case []any:
		entries = typed
	case map[string]any:
		if mcpServers, ok := typed["mcpServers"].(map[string]any); ok {
			for name, serverConfig := range mcpServers {
				entry, _ := serverConfig.(map[string]any)
				if entry == nil {
					entry = map[string]any{}
				}
				entry["name"] = name
				entries = append(entries, entry)
			}
		} else if servers, ok := typed["servers"].([]any); ok {
			entries = servers
		} else {
			entries = append(entries, typed)
		}
	}
	filtered := []map[string]any{}
	for _, entry := range entries {
		if object, ok := entry.(map[string]any); ok && len(object) > 0 {
			filtered = append(filtered, object)
		}
	}
	if len(filtered) == 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "未解析到任何服务器配置"})
		return
	}

	section := s.loadMCPSection()
	client, _ := section["client"].(map[string]any)
	if client == nil {
		client = map[string]any{"enabled": false}
	}
	servers := decodeServers(client["servers"])
	added := []string{}
	updated := []string{}
	errors := []map[string]string{}
	for _, source := range filtered {
		normalized, ok := normalizeServerFromPayload(source)
		if !ok {
			name, _ := source["name"].(string)
			errors = append(errors, map[string]string{"name": orDefault(name, "<未命名>"), "error": "缺少 name"})
			continue
		}
		if normalized.Transport == "stdio" && normalized.Command == "" {
			errors = append(errors, map[string]string{"name": normalized.Name, "error": "缺少 command"})
			continue
		}
		if normalized.Transport != "stdio" && !httpURLPattern.MatchString(normalized.URL) {
			errors = append(errors, map[string]string{"name": normalized.Name, "error": "缺少合法 URL"})
			continue
		}
		replaced := false
		for index := range servers {
			if servers[index].Name == normalized.Name {
				normalized.ID = servers[index].ID
				servers[index] = normalized
				replaced = true
				break
			}
		}
		if replaced {
			updated = append(updated, normalized.Name)
		} else {
			servers = append(servers, normalized)
			added = append(added, normalized.Name)
		}
	}
	client["servers"] = encodeServers(servers)
	section["client"] = client
	status, err := s.writeMCPSection(section)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "added": added, "updated": updated, "errors": errors, "client": status})
}

func (s *Server) handleMCPCall(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	serverID, _ := body["serverId"].(string)
	tool, _ := body["tool"].(string)
	if serverID == "" || tool == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "serverId 与 tool 不能为空"})
		return
	}
	if s.mcpClient == nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"success": false, "error": "MCP 客户端未初始化"})
		return
	}
	arguments, _ := body["arguments"].(map[string]any)
	if arguments == nil {
		arguments = map[string]any{}
	}
	startedAt := time.Now()
	text, err := s.mcpClient.CallTool(request.Context(), serverID, tool, arguments)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "ok": true, "text": text, "elapsedMs": time.Since(startedAt).Milliseconds(),
	})
}

// decodeServers / encodeServers 在 map 与 ServerConfig 之间转换（借用 Normalize）。
func decodeServers(value any) []mcp.ServerConfig {
	servers := []mcp.ServerConfig{}
	items, _ := value.([]any)
	for _, item := range items {
		object, _ := item.(map[string]any)
		if object == nil {
			continue
		}
		if server, ok := mcp.NormalizeServerConfig(object); ok {
			servers = append(servers, server)
		}
	}
	return servers
}

func encodeServers(servers []mcp.ServerConfig) []map[string]any {
	encoded := make([]map[string]any, 0, len(servers))
	for _, server := range servers {
		object := maskedServerPayload(server)
		delete(object, "hasEnv")
		delete(object, "hasHeaders")
		// 配置文件里保存原始值（掩码只用于响应）
		object["env"] = server.Env
		object["headers"] = server.Headers
		encoded = append(encoded, object)
	}
	return encoded
}
