package chat

import (
	"fmt"
	"log"
	"strings"
	"time"
	"unicode"

	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
	"mimirlink/internal/config"
	"mimirlink/internal/store"
)

// 本文件为面板「Prompt 调优靶场」提供可复用的提示词组装：
// 段序与 Runtime.buildMessages 保持一致（当前时间 → 预设四段 → 世界书 → 角色段 →
// 历史注入 → postHistory → 当前消息 → assistantPrefill），
// 但不依赖会话数据库与 OneBot 连接，历史由调用方传入（面板的模拟记忆）。

// RangeInput 是靶场组装输入。
type RangeInput struct {
	Document        *config.Document
	DataDir         string
	CharacterName   string
	WorldbookName   string
	Message         string
	MessageType     string
	GroupID         string
	UserID          string
	UserName        string
	GroupName       string
	History         []ai.Message
	InjectVariables bool
	VariableBlock   string
	// Memory/SessionKey 用于靶场复现「会话上下文注入」与「数据库召回」；
	// 未提供时跳过（与 Node 靶场缺库时的行为一致）。
	Memory       *store.DB
	SessionKey   string
	Participants []string
	// SpeakerProfile/ReplyReference 用于会话上下文注入（发言人画像 / 引用上下文）。
	SpeakerProfile string
	ReplyReference string
	// ContextOverrides 为本次调用的上下文开关覆盖（靶场 contextConfig）。
	ContextOverrides map[string]bool
	Logger           *log.Logger
}

// RangeSegment 是靶场观察面板使用的分段结构。
type RangeSegment struct {
	ID         string         `json:"id"`
	SourceSlot string         `json:"sourceSlot"`
	Kind       string         `json:"kind"`
	Label      string         `json:"label"`
	Content    string         `json:"content"`
	Order      int            `json:"order"`
	Stage      string         `json:"stage"`
	Meta       map[string]any `json:"meta"`
	Tokens     int            `json:"tokenEstimate"`
}

// BuildRangePrompt 组装靶场消息与分段。返回的分段按注入顺序排列。
func BuildRangePrompt(in RangeInput) ([]ai.Message, []RangeSegment, string, error) {
	messages := []ai.Message{}
	segments := []RangeSegment{}
	appendSegment := func(id string, kind string, label string, content string, order int, stage string, meta map[string]any) {
		if strings.TrimSpace(content) == "" {
			return
		}
		if meta == nil {
			meta = map[string]any{}
		}
		segments = append(segments, RangeSegment{
			ID: id, SourceSlot: id, Kind: kind, Label: label, Content: content,
			Order: order, Stage: stage, Meta: meta, Tokens: estimateTokens(content),
		})
	}
	appendMessage := func(segment RangeSegment) {
		role := "system"
		switch segment.Kind {
		case "history_message":
			if value, ok := segment.Meta["role"].(string); ok && value != "" {
				role = value
			}
		case "user_input":
			role = "user"
		case "assistant_prefill":
			role = "assistant"
		}
		if role != "user" && role != "assistant" {
			role = "system"
		}
		messages = append(messages, ai.Message{Role: role, Content: segment.Content})
	}
	emit := func(segment RangeSegment) {
		appendSegment(segment.ID, segment.Kind, segment.Label, segment.Content, segment.Order, segment.Stage, segment.Meta)
		appendMessage(segments[len(segments)-1])
	}

	// 1) 当前时间 + 输入头
	now := time.Now().Format("2006/1/2 15:04:05")
	emit(RangeSegment{ID: "current-time", Kind: "system_segment", Label: "当前时间", Content: "【当前时间】" + now, Order: 10, Stage: "system"})

	// 2) 预设四段
	presetResolution := resolvePresetResolution(in.Document, in.CharacterName)
	_ = presetResolution.Source
	partition := partitionPromptItems(presetResolution.Preset)
	for _, item := range partition.PreSystem {
		emit(RangeSegment{
			ID: orDefaultRange(item.Identifier, "preset-pre"), Kind: "preset_prompt", Label: orDefaultRange(item.Name, item.Identifier),
			Content: item.Content, Order: 20, Stage: "preset",
			Meta: map[string]any{"identifier": item.Identifier, "role": item.Role, "injectionPosition": item.InjectionPosition, "injectionDepth": item.InjectionDepth},
		})
	}

	// 2.5) 历史摘要段（对齐 Node src/prompt.js:710 系统段）
	if in.Memory != nil && in.SessionKey != "" {
		if summaries, err := in.Memory.ListSummaries(in.SessionKey); err == nil {
			for index, summary := range summaries {
				if content := strings.TrimSpace(summary.Content); content != "" {
					emit(RangeSegment{
						ID:      fmt.Sprintf("summary-%d", index),
						Kind:    "summary",
						Label:   fmt.Sprintf("摘要 %d", index+1),
						Content: "【历史摘要】\n" + content,
						Order:   40 + index,
						Stage:   "memory",
						Meta:    map[string]any{"placement": "system"},
					})
				}
			}
		}
	}

	// 3) 世界书匹配
	activeBook := ""
	book := rangeWorldbook(in.DataDir, in.CharacterName, in.WorldbookName)
	if book != nil {
		activeBook = book.fileName
		matched := matchWorldBookEntries(book.book, in.Message, 20, nil)
		for index, entry := range matched {
			emit(RangeSegment{
				ID: "worldbook-" + entryKeyOf(nil, entry.Keys), Kind: "worldbook_entry",
				Label: "世界书条目", Content: "【世界设定】\n" + entry.Content, Order: 30 + index, Stage: "worldbook",
				Meta: map[string]any{"keys": entry.Keys, "position": entry.Position},
			})
		}
	}

	// 3.5) 会话上下文注入（对齐 Node contextConfig：会话事实/参与者/用户意图）
	if contextText := rangeContextSegments(in); contextText != "" {
		emit(RangeSegment{ID: "situational-context", Kind: "system_segment", Label: "会话上下文", Content: contextText, Order: 45, Stage: "context"})
	}

	// 3.6) 数据库召回（对齐 Node recallSection）
	if in.Memory != nil {
		sessionKey := in.SessionKey
		if sessionKey == "" {
			sessionKey = "range_preview"
		}
		if recall := recallSectionFor(in.Memory, in.Document, in.CharacterName, sessionKey, in.Message, in.Logger); recall != "" {
			emit(RangeSegment{ID: "database-recall", Kind: "system_segment", Label: "数据库召回", Content: recall, Order: 50, Stage: "recall"})
		}
	}

	// 4) 角色卡段
	for index, segment := range rangeCharacterSegments(in.DataDir, in.CharacterName) {
		emit(RangeSegment{ID: "character-" + string(rune('a'+index)), Kind: "character_segment", Label: "角色卡", Content: segment, Order: 60 + index, Stage: "character"})
	}

	// 5) 变量状态块
	if strings.TrimSpace(in.VariableBlock) != "" {
		emit(RangeSegment{ID: "variables", Kind: "variable_block", Label: "变量状态", Content: in.VariableBlock, Order: 80, Stage: "variables"})
	}

	// 6) 历史 + historyInjection
	injections := map[int][]promptItem{}
	for _, item := range partition.HistoryInjection {
		depth := item.InjectionDepth
		if depth < 0 {
			depth = 0
		}
		if depth > len(in.History) {
			depth = len(in.History)
		}
		injections[depth] = append(injections[depth], item)
	}
	emitInjection := func(index int) {
		for _, item := range injections[index] {
			emit(RangeSegment{ID: orDefaultRange(item.Identifier, "preset-injection"), Kind: "preset_prompt", Label: "历史注入", Content: item.Content, Order: 90, Stage: "history"})
		}
	}
	emitInjection(0)
	for index, message := range in.History {
		role := message.Role
		if role != "user" && role != "assistant" {
			role = "user"
		}
		emit(RangeSegment{
			ID: "history-" + itoa(index), Kind: "history_message", Label: "历史消息 (" + role + ")",
			Content: stringValue(message.Content), Order: 95, Stage: "history", Meta: map[string]any{"role": role},
		})
		emitInjection(index + 1)
	}

	// 7) postHistory：position==1 的世界书 + 预设
	if book != nil {
		for _, entry := range matchWorldBookEntries(book.book, in.Message, 20, nil) {
			if entry.Position != 1 {
				continue
			}
			emit(RangeSegment{ID: "worldbook-post-" + entryKeyOf(nil, entry.Keys), Kind: "worldbook_entry", Label: "世界书条目(postHistory)", Content: "【世界设定】\n" + entry.Content, Order: 110, Stage: "postHistory"})
		}
	}
	for _, item := range partition.PostHistory {
		emit(RangeSegment{ID: orDefaultRange(item.Identifier, "preset-post"), Kind: "preset_prompt", Label: orDefaultRange(item.Name, item.Identifier), Content: item.Content, Order: 115, Stage: "postHistory"})
	}

	// 8) 当前消息
	emit(RangeSegment{ID: "user-input", Kind: "user_input", Label: "当前用户输入", Content: in.Message, Order: 130, Stage: "input"})

	// 9) assistantPrefill
	prefill := []string{}
	for _, item := range partition.AssistantPrefill {
		if trimmed := strings.TrimSpace(item.Content); trimmed != "" {
			prefill = append(prefill, trimmed)
		}
	}
	if len(prefill) > 0 {
		emit(RangeSegment{ID: "assistant-prefill", Kind: "assistant_prefill", Label: "assistant 预填", Content: strings.Join(prefill, "\n\n"), Order: 140, Stage: "prefill"})
	}

	return messages, segments, activeBook, nil
}

// rangeContextSegments 生成靶场/预览用的会话上下文段落，
// 开关读自 config.context.*（与运行时同一套开关）。
func rangeContextSegments(in RangeInput) string {
	if in.Document == nil {
		return ""
	}
	history := make([]store.Message, 0, len(in.History))
	for _, message := range in.History {
		history = append(history, store.Message{Role: message.Role, Content: stringValue(message.Content)})
	}
	return situationalContextFor(in.Document, SituationalInput{
		SessionKey:     in.SessionKey,
		MessageType:    in.MessageType,
		Participants:   in.Participants,
		SpeakerProfile: in.SpeakerProfile,
		ReplyReference: in.ReplyReference,
		History:        history,
		Overrides:      in.ContextOverrides,
	})
}

// RuntimePreview 是「运行时预览」响应（字段名与 Node buildChatRuntimePreview 对齐）。
type RuntimePreview struct {
	SystemSegments           []RangeSegment `json:"systemSegments"`
	HistoryInjectionSegments []RangeSegment `json:"historyInjectionSegments"`
	PostHistorySegments      []RangeSegment `json:"postHistorySegments"`
	AssistantPrefillSegments []RangeSegment `json:"assistantPrefillSegments"`
	CurrentMessageFocus      *RangeSegment  `json:"currentMessageFocusSegment"`
	HistoryMessages          []RangeSegment `json:"historyMessages"`
}

// BuildRuntimeComposition 把靶场分段按注入阶段分类，供前端「运行时预览」按槽位展示。
func BuildRuntimeComposition(segments []RangeSegment) RuntimePreview {
	composition := RuntimePreview{
		SystemSegments:           []RangeSegment{},
		HistoryInjectionSegments: []RangeSegment{},
		PostHistorySegments:      []RangeSegment{},
		AssistantPrefillSegments: []RangeSegment{},
		HistoryMessages:          []RangeSegment{},
	}
	for _, segment := range segments {
		switch segment.Stage {
		case "system", "preset", "worldbook", "character", "variables", "context", "recall":
			composition.SystemSegments = append(composition.SystemSegments, segment)
		case "history":
			if segment.Kind == "history_message" {
				composition.HistoryMessages = append(composition.HistoryMessages, segment)
			} else {
				composition.HistoryInjectionSegments = append(composition.HistoryInjectionSegments, segment)
			}
		case "postHistory":
			composition.PostHistorySegments = append(composition.PostHistorySegments, segment)
		case "prefill":
			composition.AssistantPrefillSegments = append(composition.AssistantPrefillSegments, segment)
		case "input":
			focused := segment
			composition.CurrentMessageFocus = &focused
		}
	}
	return composition
}

// BuildMessageTrace 为每条消息标注来源槽位与阶段（前端 messageTrace 用）。
func BuildMessageTrace(messages []ai.Message, segments []RangeSegment) []map[string]any {
	trace := make([]map[string]any, 0, len(messages))
	index := 0
	for _, segment := range segments {
		if index >= len(messages) {
			break
		}
		trace = append(trace, map[string]any{
			"index":        index,
			"role":         messages[index].Role,
			"sourceSlots":  []string{segment.ID},
			"sourceStages": []string{segment.Stage},
			"labels":       []string{segment.Label},
			"kind":         segment.Kind,
			"tokens":       segment.Tokens,
		})
		index++
	}
	return trace
}

// estimateTokens 与 Node estimateTokenCount 一致（中文 1.3、其他 0.3）。
func estimateTokens(text string) int {
	total := 0.0
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			total += 1.3
		} else {
			total += 0.3
		}
	}
	return int(total + 0.5)
}

// PresetBindingTrace 是预设来源追踪（对齐 Node bindingTrace.preset）。
type PresetBindingTrace struct {
	Source string `json:"source"`
	Value  any    `json:"value"`
}

// ResolvePresetTrace 暴露预设来源层与名称，供面板 bindingTrace 展示。
func ResolvePresetTrace(document *config.Document, characterName string) PresetBindingTrace {
	resolution := resolvePresetResolution(document, characterName)
	name := ""
	if resolution.Preset != nil {
		name = strings.TrimSpace(stringOf(resolution.Preset["name"]))
	}
	return PresetBindingTrace{Source: resolution.Source, Value: nilIfBlank(name)}
}

func nilIfBlank(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func orDefaultRange(value string, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

// rangeWorldbook 按「角色名 → 指定文件名 → 当前绑定」顺序解析世界书。
func rangeWorldbook(dataDir string, characterName string, explicit string) *worldBookRef {
	candidates := []string{}
	if strings.TrimSpace(explicit) != "" {
		candidates = append(candidates, explicit)
	}
	if strings.TrimSpace(characterName) != "" {
		candidates = append(candidates, characterName)
	}
	for _, candidate := range candidates {
		book, fileName, err := readWorldBook(dataDir, strings.TrimSuffix(candidate, ".json"))
		if err == nil && book != nil {
			return &worldBookRef{book: book, fileName: fileName}
		}
	}
	return nil
}

type worldBookRef struct {
	book     *worldBook
	fileName string
}

// rangeCharacterSegments 渲染角色卡描述/性格/场景段（对齐 Runtime.characterSegments）。
func rangeCharacterSegments(dataDir string, characterName string) []string {
	if strings.TrimSpace(characterName) == "" {
		return nil
	}
	data, err := characters.Read(dataDir, characterName)
	if err != nil || data == nil {
		return nil
	}
	segments := []string{}
	if description := strings.TrimSpace(stringValue(data["description"])); description != "" {
		segments = append(segments, "【角色描述】\n"+description)
	}
	displayName := strings.TrimSpace(stringValue(data["name"]))
	if displayName == "" {
		displayName = characterName
	}
	if personality := strings.TrimSpace(stringValue(data["personality"])); personality != "" {
		segments = append(segments, "【"+displayName+"的性格】\n"+personality)
	}
	if scenario := strings.TrimSpace(stringValue(data["scenario"])); scenario != "" {
		segments = append(segments, "【场景】\n"+scenario)
	}
	if systemPrompt := strings.TrimSpace(stringValue(data["system_prompt"])); systemPrompt != "" {
		segments = append(segments, systemPrompt)
	}
	return segments
}
