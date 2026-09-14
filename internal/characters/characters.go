// Package characters 负责读角色卡（SillyTavern PNG 内嵌 chara 数据或同名 JSON）。
package characters

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Card 是角色卡信息。
type Card struct {
	Name     string         `json:"name"`
	Filename string         `json:"filename"`
	Data     map[string]any `json:"-"`
}

// Dir 返回角色目录。
func Dir(dataDir string) string { return filepath.Join(dataDir, "characters") }

// List 列出角色卡（跳过 .bak 与隐藏文件）。
func List(dataDir string) []Card {
	directory := Dir(dataDir)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	cards := []Card{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		lowered := strings.ToLower(name)
		if !strings.HasSuffix(lowered, ".png") || strings.HasSuffix(lowered, ".png.bak") || strings.HasPrefix(name, ".") {
			continue
		}
		base := strings.TrimSuffix(name, filepath.Ext(name))
		card := Card{Name: base, Filename: name}
		if data, err := Read(dataDir, base); err == nil {
			if cardName, ok := data["name"].(string); ok && strings.TrimSpace(cardName) != "" {
				card.Name = cardName
			}
		}
		cards = append(cards, card)
	}
	sort.Slice(cards, func(left, right int) bool { return cards[left].Filename < cards[right].Filename })
	return cards
}

// Read 读取角色卡数据：优先 PNG 内嵌 chara/ccv3，其次同名 .json。
// 读取后合并 data/character_overrides/<name>.json 覆盖层（对齐 Node readFromPng）。
func Read(dataDir string, name string) (map[string]any, error) {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	card, err := readRaw(dataDir, base)
	if err != nil {
		return nil, err
	}
	return mergeOverrides(dataDir, base, card), nil
}

// readRaw 读取角色卡本体（不含覆盖层）。
func readRaw(dataDir string, base string) (map[string]any, error) {
	pngPath := filepath.Join(Dir(dataDir), base+".png")
	if payload, err := readPNGText(pngPath); err == nil && payload != nil {
		return payload, nil
	}
	jsonPath := filepath.Join(Dir(dataDir), base+".json")
	if raw, err := os.ReadFile(jsonPath); err == nil {
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err == nil {
			return decoded, nil
		}
	}
	return nil, fmt.Errorf("未找到角色卡: %s", base)
}

// mergeOverrides 把覆盖层字段合并进角色卡（覆盖层优先）。
func mergeOverrides(dataDir string, base string, card map[string]any) map[string]any {
	overrides := ReadOverrides(dataDir, base)
	if len(overrides) == 0 {
		return card
	}
	merged := map[string]any{}
	for key, value := range card {
		merged[key] = value
	}
	for key, value := range overrides {
		merged[key] = value
	}
	return merged
}

// Exist 判断角色卡文件是否存在。
func Exist(dataDir string, name string) bool {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	if _, err := os.Stat(filepath.Join(Dir(dataDir), base+".png")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(Dir(dataDir), base+".json")); err == nil {
		return true
	}
	return false
}

// readPNGText 解析 PNG 的 tEXt/iTXt 元数据块，返回 chara / ccv3 里的角色数据。
func readPNGText(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(raw) < 8 || !bytes.Equal(raw[:8], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}) {
		return nil, fmt.Errorf("不是 PNG 文件: %s", path)
	}
	offset := 8
	texts := map[string]string{}
	for offset+8 <= len(raw) {
		length := int(binary.BigEndian.Uint32(raw[offset : offset+4]))
		chunkType := string(raw[offset+4 : offset+8])
		dataStart := offset + 8
		dataEnd := dataStart + length
		if dataEnd > len(raw) || length < 0 {
			break
		}
		chunk := raw[dataStart:dataEnd]
		switch chunkType {
		case "tEXt":
			if index := bytes.IndexByte(chunk, 0); index > 0 {
				texts[string(chunk[:index])] = string(chunk[index+1:])
			}
		case "iTXt":
			// keyword\0 compressionFlag compressionMethod language\0 translated\0 text
			if index := bytes.IndexByte(chunk, 0); index > 0 {
				keyword := string(chunk[:index])
				rest := chunk[index+1:]
				if len(rest) >= 2 {
					rest = rest[2:] // 跳过压缩标志与方法
				}
				for part := 0; part < 2; part++ {
					if next := bytes.IndexByte(rest, 0); next >= 0 {
						rest = rest[next+1:]
					}
				}
				texts[keyword] = string(rest)
			}
		}
		offset = dataEnd + 4 // 跳过 CRC
		if chunkType == "IEND" {
			break
		}
	}
	for _, keyword := range []string{"ccv3", "chara"} {
		value, ok := texts[keyword]
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
		if err != nil {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(decoded, &payload); err != nil {
			continue
		}
		if nested, ok := payload["data"].(map[string]any); ok {
			return nested, nil
		}
		return payload, nil
	}
	return nil, fmt.Errorf("PNG 内未找到角色数据: %s", path)
}

// Summary 返回角色卡的关键字段摘要（供面板展示）。
func Summary(data map[string]any) map[string]any {
	if data == nil {
		return nil
	}
	pick := func(key string) any { return data[key] }
	return map[string]any{
		"name":        pick("name"),
		"description": pick("description"),
		"personality": pick("personality"),
		"scenario":    pick("scenario"),
		"first_mes":   pick("first_mes"),
		"mes_example": pick("mes_example"),
		"creator":     pick("creator"),
		"tags":        pick("tags"),
		"versions":    pick("character_version"),
	}
}
