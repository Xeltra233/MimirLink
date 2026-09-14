package panel

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"mimirlink/internal/store"
)

// 本文件补齐全局搜索与聊天记录搜索（对齐 Node 版 /api/search 与 /api/memory/search）。

func (s *Server) registerSearchRoutes() {
	s.mux.HandleFunc("/api/search", s.requireAuth(s.handleGlobalSearch))
	s.mux.HandleFunc("/api/memory/search", s.requireAuth(s.handleMemorySearch))
}

// searchQuery 归一化 q/limit（对齐 Node normalizeSearchQuery：limit 1-20 默认 8）。
func searchQuery(query map[string][]string) (string, int) {
	get := func(key string) string {
		if values, ok := query[key]; ok && len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
		return ""
	}
	q := get("q")
	if q == "" {
		q = get("query")
	}
	if q == "" {
		q = get("keyword")
	}
	limit := 8
	if raw := get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 20 {
			limit = parsed
		}
	}
	return q, limit
}

// fuzzyMatch 对齐 Node fuzzyMatch：子串命中或子序列命中（大小写不敏感）。
func fuzzyMatch(value string, query string) bool {
	v := strings.ToLower(value)
	q := strings.ToLower(query)
	if q == "" {
		return true
	}
	if strings.Contains(v, q) {
		return true
	}
	qi := 0
	for vi := 0; vi < len(v) && qi < len(q); vi++ {
		if v[vi] == q[qi] {
			qi++
		}
	}
	return qi == len(q)
}

// searchResult 对齐 Node buildSearchResult 的形状。
type searchResult struct {
	Type     string         `json:"type"`
	Title    string         `json:"title"`
	Subtitle string         `json:"subtitle"`
	Preview  string         `json:"preview"`
	PanelID  string         `json:"panelId"`
	EntryID  string         `json:"entryId"`
	Score    int            `json:"score"`
	Action   map[string]any `json:"action"`
}

type searchGroup struct {
	Type  string         `json:"type"`
	Label string         `json:"label"`
	Items []searchResult `json:"items"`
	Count int            `json:"count"`
}

func trimResult(result searchResult) searchResult {
	result.Title = strings.TrimSpace(result.Title)
	result.Subtitle = strings.TrimSpace(result.Subtitle)
	result.Preview = strings.TrimSpace(result.Preview)
	return result
}

// handleGlobalSearch 联合搜索知识/变量/聊天记录（GET /api/search?q=&limit=）。
func (s *Server) handleGlobalSearch(writer http.ResponseWriter, request *http.Request) {
	q, limit := searchQuery(request.URL.Query())
	if q == "" {
		writeJSON(writer, http.StatusOK, map[string]any{
			"success": true, "query": "", "groups": []searchGroup{}, "results": []searchResult{}, "recentEligible": false,
		})
		return
	}

	groups := []searchGroup{}
	all := []searchResult{}
	pushGroup := func(resultType string, label string, items []searchResult) {
		limited := []searchResult{}
		for _, item := range items {
			item = trimResult(item)
			if item.Title == "" && item.Preview == "" {
				continue
			}
			limited = append(limited, item)
		}
		// 按分数排序后截断
		for i := 0; i < len(limited); i++ {
			for j := i + 1; j < len(limited); j++ {
				if limited[j].Score > limited[i].Score {
					limited[i], limited[j] = limited[j], limited[i]
				}
			}
		}
		if len(limited) > limit {
			limited = limited[:limit]
		}
		if len(limited) == 0 {
			return
		}
		for index := range limited {
			limited[index].Type = resultType
			all = append(all, limited[index])
		}
		groups = append(groups, searchGroup{Type: resultType, Label: label, Items: limited, Count: len(limited)})
	}

	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()

	// 知识库（fuzzy 过滤 title/content，对齐 Node includesSearchText）
	if knowledge, err := database.ListKnowledgeEntriesFiltered(store.VariableFilters{Search: q, Limit: limit * 3}); err == nil {
		items := []searchResult{}
		for _, item := range knowledge {
			if !fuzzyMatch(item.Title, q) && !fuzzyMatch(item.Content, q) {
				continue
			}
			score := 20
			if fuzzyMatch(item.Title, q) {
				score = 30
			}
			items = append(items, searchResult{
				Title:    orDefault(item.Title, "未命名知识"),
				Subtitle: orDefault(item.KnowledgeType, "knowledge") + " · " + orDefault(item.ScopeType, "-") + " / " + orDefault(item.ScopeKey, "-"),
				Preview:  item.Content,
				PanelID:  "knowledge",
				EntryID:  item.ID,
				Score:    score,
				Action:   map[string]any{"kind": "knowledge", "id": item.ID},
			})
		}
		pushGroup("knowledge", "知识库", items)
	}

	// 变量
	if variables, err := database.ListVariables(store.VariableFilters{Search: q, Limit: limit * 3}); err == nil {
		items := []searchResult{}
		for _, item := range variables {
			if !fuzzyMatch(item.Key, q) && !fuzzyMatch(item.Title, q) && !fuzzyMatch(item.RawValue, q) {
				continue
			}
			score := 20
			if fuzzyMatch(item.Key, q) || fuzzyMatch(item.Title, q) {
				score = 30
			}
			items = append(items, searchResult{
				Title:    orDefault(item.Key, "未命名变量"),
				Subtitle: orDefault(item.ValueType, "string") + " · " + orDefault(item.ScopeType, "-") + " / " + orDefault(item.ScopeKey, "-"),
				Preview:  item.RawValue,
				PanelID:  "variables",
				EntryID:  item.ID,
				Score:    score,
				Action:   map[string]any{"kind": "variable", "id": item.ID},
			})
		}
		pushGroup("variable", "变量", items)
	}

	// 聊天记录（SQLite LIKE 子串）
	if messages, err := database.SearchMessages(q, limit); err == nil {
		items := make([]searchResult, 0, len(messages))
		for _, item := range messages {
			items = append(items, searchResult{
				Title:    item.SessionID,
				Subtitle: formatTimestampCN(item.Timestamp),
				Preview:  item.Content,
				PanelID:  "sessions",
				EntryID:  item.SessionID,
				Score:    10,
				Action:   map[string]any{"kind": "session", "id": item.SessionID},
			})
		}
		pushGroup("message", "聊天记录", items)
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "query": q, "groups": groups, "results": all, "recentEligible": false,
	})
}

// handleMemorySearch 全局记忆搜索（POST /api/memory/search {keyword, limit}，对齐 Node）。
func (s *Server) handleMemorySearch(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	keyword := textOf(body["keyword"])
	if keyword == "" {
		keyword = textOf(body["q"])
	}
	limit := 50
	if parsed, ok := body["limit"].(float64); ok && parsed >= 1 {
		limit = int(parsed)
	}
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	results, err := database.SearchMessages(keyword, limit)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"results": results, "count": len(results)})
}

func orDefault(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func formatTimestampCN(timestamp int64) string {
	if timestamp <= 0 {
		return "聊天记录"
	}
	return time.Unix(timestamp, 0).Format("2006/1/2 15:04:05")
}
