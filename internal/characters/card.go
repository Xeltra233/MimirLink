package characters

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
)

// 本文件补齐角色卡「写回」链路，对齐 Node 版 src/character.js 的 CharacterManager：
//
//   - SillyTavern 标准字段写回 PNG 内嵌 chara/ccv3 数据块（重算 CRC）；
//   - MimirLink 独有字段写入 data/character_overrides/<name>.json 覆盖层；
//   - 读取时把覆盖层合并进角色卡数据。
//
// 之前的 Go 实现直接把整张卡写成 characters/<name>.json，导致两种后果：
// PNG 里的数据从未更新（读路径优先 PNG），且 Node 版看不到 .json 角色卡。

// stFields 是写回 PNG 的标准字段（与 Node stFields 一致）。
var stFields = map[string]bool{
	"name": true, "description": true, "personality": true, "scenario": true,
	"first_mes": true, "mes_example": true, "system_prompt": true,
	"post_history_instructions": true, "creator_notes": true, "creatorcomment": true,
	"talkativeness": true, "fav": true, "tags": true, "alternate_greetings": true,
	"extensions": true, "character_book": true, "variable_defaults": true,
}

func baseName(name string) string {
	return strings.TrimSuffix(filepath.Base(strings.TrimSpace(name)), filepath.Ext(name))
}

// OverridesPath 返回角色覆盖层文件路径。
func OverridesPath(dataDir string, name string) string {
	return filepath.Join(dataDir, "character_overrides", baseName(name)+".json")
}

// ReadOverrides 读取覆盖层；文件缺失或损坏时返回空 map（与 Node 的 try/catch 一致）。
func ReadOverrides(dataDir string, name string) map[string]any {
	overrides := map[string]any{}
	raw, err := os.ReadFile(OverridesPath(dataDir, name))
	if err != nil {
		return overrides
	}
	if err := json.Unmarshal(raw, &overrides); err != nil {
		return map[string]any{}
	}
	return overrides
}

// WriteOverrides 写入覆盖层（空 map 时删除文件）。
func WriteOverrides(dataDir string, name string, overrides map[string]any) error {
	path := OverridesPath(dataDir, name)
	if len(overrides) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(overrides, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, encoded, 0o644)
}

// Update 对齐 Node CharacterManager.updateCharacter：标准字段写回 PNG，本地字段写覆盖层。
func Update(dataDir string, name string, updates map[string]any) (map[string]any, error) {
	base := baseName(name)
	pngPath := filepath.Join(Dir(dataDir), base+".png")
	if _, err := os.Stat(pngPath); err != nil {
		return nil, fmt.Errorf("角色文件不存在: %s", pngPath)
	}

	stUpdates := map[string]any{}
	localUpdates := map[string]any{}
	for key, value := range updates {
		if stFields[key] {
			stUpdates[key] = value
		} else {
			localUpdates[key] = value
		}
	}

	overrides := ReadOverrides(dataDir, base)

	if len(stUpdates) > 0 {
		current, err := readPNGPayload(pngPath)
		if err != nil {
			return nil, err
		}
		merged := map[string]any{}
		for key, value := range current {
			merged[key] = value
		}
		for key, value := range stUpdates {
			merged[key] = value
		}
		// 对齐 Node：ST 卡内 data 层同步更新
		if nested, ok := merged["data"].(map[string]any); ok {
			for key, value := range stUpdates {
				nested[key] = value
			}
		}
		if err := writePNGPayload(pngPath, merged); err != nil {
			return nil, err
		}
	}

	if len(localUpdates) > 0 {
		next := map[string]any{}
		for key, value := range overrides {
			next[key] = value
		}
		for key, value := range localUpdates {
			next[key] = value
		}
		for field := range stFields {
			delete(next, field)
		}
		if err := WriteOverrides(dataDir, base, next); err != nil {
			return nil, err
		}
	} else if len(stUpdates) > 0 && len(overrides) > 0 {
		for field := range stFields {
			delete(overrides, field)
		}
		if err := WriteOverrides(dataDir, base, overrides); err != nil {
			return nil, err
		}
	}

	return Read(dataDir, base)
}

// readPNGPayload 读取 PNG 内嵌 chara/ccv3（不合并覆盖层）。
func readPNGPayload(pngPath string) (map[string]any, error) {
	return readPNGText(pngPath)
}

// writePNGPayload 重写 PNG 内嵌数据：把 chara/ccv3 块替换为新的 tEXt 块并重算 CRC。
func writePNGPayload(pngPath string, payload map[string]any) error {
	raw, err := os.ReadFile(pngPath)
	if err != nil {
		return err
	}
	if len(raw) < 8 || !bytes.Equal(raw[:8], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}) {
		return fmt.Errorf("不是 PNG 文件: %s", pngPath)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	base64Text := base64.StdEncoding.EncodeToString(encoded)

	signature := raw[:8]
	offset := 8
	replaced := false
	chunks := [][]byte{}
	for offset+8 <= len(raw) {
		length := int(binary.BigEndian.Uint32(raw[offset : offset+4]))
		chunkType := string(raw[offset+4 : offset+8])
		dataStart := offset + 8
		dataEnd := dataStart + length
		if length < 0 || dataEnd+4 > len(raw) {
			return fmt.Errorf("PNG 结构损坏: %s", pngPath)
		}
		chunkData := raw[dataStart:dataEnd]
		if chunkType == "tEXt" || chunkType == "iTXt" {
			if index := bytes.IndexByte(chunkData, 0); index > 0 {
				keyword := string(chunkData[:index])
				if keyword == "chara" || keyword == "ccv3" {
					chunks = append(chunks, buildTextChunk(keyword, base64Text))
					offset = dataEnd + 4
					replaced = true
					continue
				}
			}
		}
		chunks = append(chunks, raw[offset:dataEnd+4])
		offset = dataEnd + 4
	}
	if !replaced {
		// 没有 chara/ccv3 块：在 IHDR 之后插入新的 chara 块
		if len(chunks) == 0 {
			return fmt.Errorf("PNG 结构损坏: %s", pngPath)
		}
		inserted := [][]byte{chunks[0], buildTextChunk("chara", base64Text)}
		inserted = append(inserted, chunks[1:]...)
		chunks = inserted
	}

	output := bytes.NewBuffer(nil)
	output.Write(signature)
	for _, chunk := range chunks {
		output.Write(chunk)
	}
	return os.WriteFile(pngPath, output.Bytes(), 0o644)
}

// buildTextChunk 构造 tEXt 块（keyword\0base64）。
func buildTextChunk(keyword string, value string) []byte {
	data := append([]byte(keyword+"\x00"), []byte(value)...)
	length := make([]byte, 4)
	binary.BigEndian.PutUint32(length, uint32(len(data)))
	chunkType := []byte("tEXt")
	crcData := append(append([]byte{}, chunkType...), data...)
	crc := make([]byte, 4)
	binary.BigEndian.PutUint32(crc, crc32.ChecksumIEEE(crcData))
	return append(append(append(length, chunkType...), data...), crc...)
}

// minimalPNGBase 是 1x1 真彩 PNG 的固定块（IHDR/IDAT/IEND），用作新建角色卡的底图。
var minimalPNGBase = [][]byte{
	// IHDR: 1x1, 8bit, RGBA
	{0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89},
	// IDAT: 透明像素
	{0x00, 0x00, 0x00, 0x0a, 'I', 'D', 'A', 'T', 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
		0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4},
	// IEND
	{0x00, 0x00, 0x00, 0x00, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82},
}

// Create 用最小 PNG 底图新建角色卡，并把角色数据内嵌进 chara 块。
// 用于面板上传/导入只拿到 JSON 卡而目录里还没有 PNG 的情况。
func Create(dataDir string, name string, payload map[string]any) error {
	base := baseName(name)
	if base == "" {
		return fmt.Errorf("角色名不能为空")
	}
	if err := os.MkdirAll(Dir(dataDir), 0o755); err != nil {
		return err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	output := bytes.NewBuffer(nil)
	output.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	output.Write(minimalPNGBase[0])
	output.Write(buildTextChunk("chara", base64.StdEncoding.EncodeToString(encoded)))
	output.Write(minimalPNGBase[1])
	output.Write(minimalPNGBase[2])
	return os.WriteFile(filepath.Join(Dir(dataDir), base+".png"), output.Bytes(), 0o644)
}
