// Package mask 提供配置密钥脱敏，行为与 Node 版 src/secret-mask.js 一致。
//
// 用途：脱敏备份导出、日志与接口输出。真实配置文件与「含密钥」备份不做任何改动。
package mask

import "strings"

// Value 是统一使用的掩码文本。
const Value = "******"

var maskedKeys = map[string]bool{
	"apikey":        true,
	"accesstoken":   true,
	"password":      true,
	"sessionsecret": true,
	"secret":        true,
	"token":         true,
}

// 密钥容器：容器内按键名特征脱敏；apiKeys 容器全量脱敏。
var secretContainers = map[string]bool{
	"headers": true,
	"env":     true,
	"apikeys": true,
}

func looksSecret(key string) bool {
	lower := strings.ToLower(key)
	for _, marker := range []string{"key", "token", "secret", "password", "passwd", "credential", "cookie", "auth"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// Secrets 返回脱敏后的配置副本（不修改入参）。
func Secrets(value any) any {
	return walk(value, "")
}

func walk(node any, containerKey string) any {
	switch typed := node.(type) {
	case map[string]any:
		inside := secretContainers[containerKey]
		maskAll := containerKey == "apikeys"
		for key, child := range typed {
			switch nested := child.(type) {
			case map[string]any:
				typed[key] = walk(nested, strings.ToLower(key))
			case []any:
				typed[key] = walkList(nested, strings.ToLower(key))
			case string:
				if nested == "" {
					continue
				}
				lowerKey := strings.ToLower(key)
				if maskAll || maskedKeys[lowerKey] || (inside && looksSecret(key)) {
					typed[key] = Value
				}
			}
		}
		return typed
	case []any:
		return walkList(typed, containerKey)
	default:
		return node
	}
}

func walkList(items []any, containerKey string) []any {
	for index, item := range items {
		switch nested := item.(type) {
		case map[string]any:
			items[index] = walk(nested, containerKey)
		case []any:
			items[index] = walkList(nested, containerKey)
		}
	}
	return items
}
