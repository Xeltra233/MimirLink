package chat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// 本文件移植 Node src/worldbook.js：世界书读取与条目匹配
// （keys/secondary_keys + selectiveLogic、constant、sticky、order、position）。

// worldBookEntry 是世界书条目的宽容解析形状。
type worldBookEntry struct {
	UID            any      `json:"uid"`
	ID             any      `json:"id"`
	Keys           []string `json:"-"`
	SecondaryKeys  []string `json:"-"`
	Content        string
	Comment        string
	Order          float64
	Position       int
	Sticky         float64
	Constant       bool
	Enabled        bool
	Disable        bool
	SelectiveLogic float64
	EntryKey       string
}

type worldBook struct {
	Entries []map[string]any `json:"entries"`
}

// readWorldBook 对齐 Node WorldBookManager.readWorldBook 的文件名匹配链。
func readWorldBook(dataDir string, characterName string) (*worldBook, string, error) {
	if characterName == "" {
		return nil, "", nil
	}
	worldsDir := filepath.Join(dataDir, "worlds")
	candidates := []string{
		characterName + "’s Lorebook.json",
		characterName + "'s Lorebook.json",
		characterName + " Lorebook.json",
		characterName + ".json",
	}
	for _, name := range candidates {
		path := filepath.Join(worldsDir, name)
		if book, err := loadWorldBookFile(path); err == nil {
			return book, name, nil
		}
	}
	entries, err := os.ReadDir(worldsDir)
	if err != nil {
		return nil, "", nil
	}
	for _, file := range entries {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		if !strings.Contains(file.Name(), characterName) {
			continue
		}
		path := filepath.Join(worldsDir, file.Name())
		if book, err := loadWorldBookFile(path); err == nil {
			return book, file.Name(), nil
		}
	}
	return nil, "", nil
}

func loadWorldBookFile(path string) (*worldBook, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var book worldBook
	if err := json.Unmarshal(data, &book); err != nil {
		return nil, err
	}
	return &book, nil
}

func worldBookKeys(value any) []string {
	switch typed := value.(type) {
	case []any:
		keys := []string{}
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				keys = append(keys, text)
			}
		}
		return keys
	case string:
		if strings.TrimSpace(typed) != "" {
			return []string{typed}
		}
	}
	return nil
}

func worldBookEnabled(value any, fallback bool) bool {
	switch typed := value.(type) {
	case nil:
		return fallback
	case bool:
		return typed
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		switch normalized {
		case "":
			return fallback
		case "false", "0", "off", "no":
			return false
		case "true", "1", "on", "yes":
			return true
		}
		return typed != ""
	case float64:
		return typed != 0
	default:
		return fallback
	}
}

func worldBookNumber(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return parsed
		}
	case int:
		return float64(typed)
	case bool:
		if typed {
			return 1
		}
		return 0
	}
	return fallback
}

// resolveWorldBookPosition 对齐 Node normalizePosition（数字仅 1 为 after，其余为 0）。
func resolveWorldBookPosition(value any) int {
	if text, ok := value.(string); ok {
		normalized := strings.ToLower(strings.TrimSpace(text))
		switch normalized {
		case "1", "after", "after_char", "after_character", "after_description", "post", "post_history", "post-history":
			return 1
		case "0", "before", "before_char", "before_character", "before_description", "system", "pre_history", "pre-history":
			return 0
		}
	}
	// Node 数字分支：Number.isFinite ? (===1?1:0)；非 1（含 2/-1）一律落 0
	if worldBookNumber(value, 0) == 1 {
		return 1
	}
	return 0
}

// matchedWorldBookEntry 是匹配后的条目（对齐 Node matchEntries 输出）。
type matchedWorldBookEntry struct {
	Content            string
	Order              float64
	Key                string
	Keys               []string
	Comment            string
	Position           int
	Sticky             float64
	IsConstant         bool
	TriggeredByKeyword bool
	TriggeredBySticky  bool
}

// matchWorldBookEntries 对齐 Node matchEntries：常驻 + 关键词 + 粘性，按 order 降序截断。
func matchWorldBookEntries(book *worldBook, inputText string, maxEntries int, stickyKeys map[string]bool) []matchedWorldBookEntry {
	if book == nil || len(book.Entries) == 0 {
		return nil
	}
	if maxEntries <= 0 {
		maxEntries = 10
	}
	if stickyKeys == nil {
		stickyKeys = map[string]bool{}
	}
	inputLower := strings.ToLower(inputText)
	constants := []matchedWorldBookEntry{}
	matched := []matchedWorldBookEntry{}
	stickyMatched := []matchedWorldBookEntry{}

	for _, raw := range book.Entries {
		if !worldBookEnabled(raw["enabled"], true) || worldBookEnabled(raw["disable"], false) {
			continue
		}
		keys := worldBookKeys(orValue(raw["keys"], raw["key"]))
		entryKey := entryKeyOf(raw, keys)
		sticky := worldBookNumber(raw["sticky"], 0)
		order := worldBookNumber(orValue(raw["order"], raw["insertion_order"]), 0)
		position := resolveWorldBookPosition(raw["position"])

		if worldBookEnabled(raw["constant"], false) {
			constants = append(constants, matchedWorldBookEntry{
				Content: stringOf(raw["content"]), Order: order, Key: entryKey,
				IsConstant: true, Position: position,
			})
			continue
		}

		isStickyActive := stickyKeys[entryKey]
		secondaryKeys := worldBookKeys(orValue(raw["secondary_keys"], raw["keysecondary"]))
		primaryMatch := false
		secondaryMatch := len(secondaryKeys) == 0
		for _, key := range keys {
			if key != "" && strings.Contains(inputLower, strings.ToLower(key)) {
				primaryMatch = true
				break
			}
		}
		if primaryMatch && len(secondaryKeys) > 0 {
			logic := worldBookNumber(raw["selectiveLogic"], 0)
			switch int(logic) {
			case 0:
				for _, k := range secondaryKeys {
					if k != "" && strings.Contains(inputLower, strings.ToLower(k)) {
						secondaryMatch = true
						break
					}
				}
			case 1:
				allContain := true
				for _, k := range secondaryKeys {
					if k == "" || !strings.Contains(inputLower, strings.ToLower(k)) {
						allContain = false
						break
					}
				}
				secondaryMatch = !allContain
			case 2:
				secondaryMatch = true
				for _, k := range secondaryKeys {
					if k != "" && strings.Contains(inputLower, strings.ToLower(k)) {
						secondaryMatch = false
						break
					}
				}
			case 3:
				secondaryMatch = true
				for _, k := range secondaryKeys {
					if k == "" || !strings.Contains(inputLower, strings.ToLower(k)) {
						secondaryMatch = false
						break
					}
				}
			}
		}
		keywordMatch := primaryMatch && secondaryMatch
		if !keywordMatch && !isStickyActive {
			continue
		}
		entry := matchedWorldBookEntry{
			Content: stringOf(raw["content"]), Order: order, Key: entryKey, Keys: keys,
			Comment:  firstNonEmptyString(stringOf(raw["comment"]), stringOf(raw["name"]), firstOf(keys), "未命名"),
			Position: position, Sticky: sticky,
			TriggeredByKeyword: keywordMatch, TriggeredBySticky: isStickyActive && !keywordMatch,
		}
		if keywordMatch {
			matched = append(matched, entry)
		} else {
			stickyMatched = append(stickyMatched, entry)
		}
	}

	all := append(append(constants, matched...), stickyMatched...)
	sort.SliceStable(all, func(i, j int) bool { return all[i].Order > all[j].Order })
	if len(all) > maxEntries {
		all = all[:maxEntries]
	}
	return all
}

func entryKeyOf(raw map[string]any, keys []string) string {
	for _, field := range []string{"uid", "id"} {
		if value, ok := raw[field]; ok && value != nil {
			if text := stringOf(value); text != "" {
				return text
			}
			if number, ok := value.(float64); ok {
				return fmt.Sprintf("%v", number)
			}
		}
	}
	if len(keys) > 0 && keys[0] != "" {
		return keys[0]
	}
	return firstNonEmptyString(stringOf(raw["comment"]), stringOf(raw["name"]), "unknown")
}

func orValue(primary any, secondary any) any {
	if primary != nil {
		return primary
	}
	return secondary
}

func stringOf(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func firstOf(values []string) string {
	if len(values) > 0 {
		return values[0]
	}
	return ""
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
