// Command mimir 是 MimirLink 的 Go 实现入口。
//
// 当前阶段（P2）提供数据盘点能力，用于验证 Go 版与 Node 版读写同一份数据：
//
//	go run ./cmd/mimir -check-data              # 人类可读摘要
//	go run ./cmd/mimir -check-data -json        # 机器可读 JSON（供 Node 侧对比）
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/backup"
	"mimirlink/internal/chat"
	"mimirlink/internal/config"
	"mimirlink/internal/datacheck"
	"mimirlink/internal/mcp"
	"mimirlink/internal/onebot"
	"mimirlink/internal/panel"
	"mimirlink/internal/search"
	"mimirlink/internal/store"
	"mimirlink/internal/tools"
)

const version = "0.1.0-dev"

func main() {
	var (
		rootDir     = flag.String("root", ".", "MimirLink 根目录（含 config.json 与 data/）")
		checkData   = flag.Bool("check-data", false, "盘点数据目录并输出统计")
		asJSON      = flag.Bool("json", false, "以 JSON 输出（配合 -check-data）")
		roundtrip   = flag.String("roundtrip-config", "", "读取 config.json 后另存到指定路径（用于格式/键顺序保真核对）")
		backupOut   = flag.String("backup", "", "导出备份到指定 tar.gz 路径")
		inspect     = flag.String("inspect", "", "检查备份包含的分类")
		restore     = flag.String("restore", "", "从备份归档恢复数据")
		includeKeys = flag.Bool("include-keys", false, "导出时包含密钥（默认脱敏）")
		categories  = flag.String("categories", "", "备份分类，逗号分隔（默认全部）")
		serve       = flag.Bool("serve", false, "启动面板 HTTP 服务")
		botMode     = flag.Bool("bot", false, "启动 QQ Bot（OneBot + AI）")
		searchQuery = flag.String("search", "", "执行一次搜索并打印结果（验证用）")
		searchLimit = flag.Int("search-limit", 5, "搜索条数")
		searchFetch = flag.String("search-fetch", "", "抓取指定网址正文（验证用）")
		recallDB    = flag.String("recall", "", "对指定记忆库执行记忆召回（验证用）")
		recallQuery = flag.String("recall-query", "", "召回查询文本")
		recallScope = flag.String("recall-scope", "global_shared", "召回命名空间 scopeType")
		recallKey   = flag.String("recall-key", "global_shared_memory", "召回命名空间 scopeKey")
		recallChar  = flag.String("recall-character", "", "召回命名空间角色名")
		mcpList     = flag.Bool("mcp-list", false, "连接配置里的 MCP 服务器并列出工具")
		mcpCall     = flag.String("mcp-call", "", "调用指定 MCP 工具（函数名）")
		mcpArgs     = flag.String("mcp-args", "{}", "MCP 工具参数（JSON）")
		port        = flag.Int("port", 0, "覆盖监听端口（默认取 config.server.port）")
		showVer     = flag.Bool("version", false, "输出版本")
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("mimir-go %s\n", version)
		return
	}

	absoluteRoot, err := filepath.Abs(*rootDir)
	if err != nil {
		fail("解析根目录失败: %v", err)
	}

	if *mcpList || *mcpCall != "" {
		runMCPProbe(absoluteRoot, *mcpCall, *mcpArgs)
		return
	}

	if *recallDB != "" {
		runRecallProbe(*recallDB, *recallQuery, *recallScope, *recallKey, *recallChar)
		return
	}

	if *searchQuery != "" || *searchFetch != "" {
		runSearchProbe(absoluteRoot, *searchQuery, *searchLimit, *searchFetch)
		return
	}

	if *botMode {
		if err := runBot(absoluteRoot); err != nil {
			fail("Bot 运行失败: %v", err)
		}
		return
	}

	if *serve {
		if err := servePanel(absoluteRoot, *port); err != nil {
			fail("面板服务失败: %v", err)
		}
		return
	}

	if *roundtrip != "" {
		document, err := config.Load(filepath.Join(absoluteRoot, "config.json"))
		if err != nil {
			fail("读取配置失败: %v", err)
		}
		if err := document.SaveTo(*roundtrip); err != nil {
			fail("写回配置失败: %v", err)
		}
		fmt.Printf("已写出配置副本: %s（顶层键 %d 个）\n", *roundtrip, len(document.Keys()))
		return
	}

	backupOptions := backup.Options{
		RootDir:     absoluteRoot,
		IncludeKeys: *includeKeys,
		Categories:  splitCategories(*categories),
	}

	if *backupOut != "" {
		file, err := os.Create(*backupOut)
		if err != nil {
			fail("创建备份文件失败: %v", err)
		}
		if err := backup.Export(backupOptions, file); err != nil {
			_ = file.Close()
			fail("导出备份失败: %v", err)
		}
		if err := file.Close(); err != nil {
			fail("写入备份失败: %v", err)
		}
		info, _ := os.Stat(*backupOut)
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		categoriesLabel := strings.Join(backupOptions.Categories, ",")
		if categoriesLabel == "" {
			categoriesLabel = "全部"
		}
		fmt.Printf("已导出备份: %s（%s，%.1f KB，分类 %s）\n", *backupOut, backupOptions.ArchiveName(), float64(size)/1024, categoriesLabel)
		return
	}

	if *inspect != "" {
		found, err := backup.Inspect(*inspect)
		if err != nil {
			fail("识别备份失败: %v", err)
		}
		fmt.Printf("备份分类: %s\n", strings.Join(found, ", "))
		return
	}

	if *restore != "" {
		changes, err := backup.Restore(backupOptions, *restore)
		if err != nil {
			fail("恢复失败: %v", err)
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(changes); err != nil {
			fail("输出恢复结果失败: %v", err)
		}
		return
	}

	if !*checkData {
		fmt.Println("mimir-go", version)
		fmt.Println("可用命令：")
		fmt.Println("  -check-data              盘点 config.json 与 data/（可加 -json）")
		fmt.Println("  -roundtrip-config <路径>  配置读写往返（保真核对）")
		fmt.Println("  -backup <路径>           导出备份（可加 -include-keys / -categories）")
		fmt.Println("  -inspect <归档>          识别备份分类")
		fmt.Println("  -restore <归档>          从备份恢复")
		fmt.Println("  -serve                   启动面板 HTTP 服务（可加 -port）")
		fmt.Println("  -bot                     启动 QQ Bot（连接 OneBot 并回复消息）")
		fmt.Println("  -search <关键词>          执行一次搜索并打印结果（可加 -search-limit）")
		fmt.Println("  -search-fetch <网址>      抓取网页正文（验证用）")
		fmt.Println("  -recall <记忆库>          对记忆库执行召回并输出 JSON（可加 -recall-query/-recall-character）")
		fmt.Println("  -mcp-list                连接配置里的 MCP 服务器并列出工具")
		fmt.Println("  -mcp-call <工具名>        调用 MCP 工具（可加 -mcp-args）")
		fmt.Println("  -version                 输出版本")
		return
	}

	report, err := datacheck.Build(absoluteRoot)
	if err != nil {
		fail("数据盘点失败: %v", err)
	}

	if *asJSON {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			fail("输出 JSON 失败: %v", err)
		}
		return
	}
	fmt.Print(report.Summary())
}

func servePanel(rootDir string, portOverride int) error {
	document, err := config.Load(filepath.Join(rootDir, "config.json"))
	if err != nil {
		return err
	}
	port := portOverride
	if port == 0 {
		port = int(document.Int("server.port", 18081))
	}
	host := document.String("server.host")
	if host == "" {
		host = "0.0.0.0"
	}
	server, err := panel.NewServer(panel.Options{
		RootDir:  rootDir,
		Document: document,
		Logger:   log.New(os.Stdout, "", log.LstdFlags),
	})
	if err != nil {
		return err
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("监听 %s 失败: %w", address, err)
	}
	httpServer := &http.Server{Handler: server.Handler(), ReadHeaderTimeout: 15 * time.Second}
	fmt.Printf("MimirLink(Go) 面板已启动: http://%s （认证: %v，数据目录: %s）\n", address, document.Bool("auth.enabled"), server.DataDir())

	go func() {
		signalChannel := make(chan os.Signal, 1)
		signal.Notify(signalChannel, os.Interrupt, syscall.SIGTERM)
		<-signalChannel
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownContext)
	}()

	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		return err
	}
	fmt.Println("面板已停止")
	return nil
}

func runMCPProbe(rootDir string, callName string, callArgs string) {
	document, err := config.Load(filepath.Join(rootDir, "config.json"))
	if err != nil {
		fail("读取配置失败: %v", err)
	}
	logger := log.New(os.Stdout, "", log.LstdFlags)
	var raw map[string]any
	if err := json.Unmarshal(document.Raw(), &raw); err != nil {
		fail("解析配置失败: %v", err)
	}
	mcpSection, _ := raw["mcp"].(map[string]any)
	clientConfig := mcp.LoadConfig(mcpSection)
	fmt.Printf("启用: %v | 服务器: %d 个 | 结果上限: %d 字\n", clientConfig.Enabled, len(clientConfig.Servers), clientConfig.MaxResultChars)
	if !clientConfig.Enabled {
		fmt.Println("提示：mcp.client.enabled 为 false，未连接任何服务器")
		return
	}
	client := mcp.New(clientConfig, logger)
	client.ConnectAll(context.Background())
	defer client.Close()
	definitions := client.Definitions()
	if callName != "" {
		arguments := map[string]any{}
		if err := json.Unmarshal([]byte(callArgs), &arguments); err != nil {
			fail("参数不是合法 JSON: %v", err)
		}
		definition, ok := client.Lookup(callName)
		if !ok {
			fail("找不到工具: %s（可用 -mcp-list 查看）", callName)
		}
		startedAt := time.Now()
		text, err := client.CallTool(context.Background(), definition.ServerID, definition.ToolName, arguments)
		if err != nil {
			fail("调用失败（%dms）: %v", time.Since(startedAt).Milliseconds(), err)
		}
		fmt.Printf("调用 %s（%s/%s）用时 %dms，返回 %d 字：\n%s\n",
			callName, definition.ServerName, definition.ToolName,
			time.Since(startedAt).Milliseconds(), len([]rune(text)), truncateText(text, 800))
		return
	}
	fmt.Printf("\n可用工具: %d 个\n", len(definitions))
	for _, item := range definitions {
		description := ""
		if function, ok := item.Definition["function"].(map[string]any); ok {
			description = fmt.Sprintf("%v", function["description"])
		}
		paramNames := []string{}
		if function, ok := item.Definition["function"].(map[string]any); ok {
			if parameters, ok := function["parameters"].(map[string]any); ok {
				if properties, ok := parameters["properties"].(map[string]any); ok {
					for key := range properties {
						paramNames = append(paramNames, key)
					}
					sort.Strings(paramNames)
				}
			}
		}
		fmt.Printf("  %-40s [%s] 参数(%s) %s\n", item.Name, item.ServerName, strings.Join(paramNames, ","), truncateText(description, 50))
	}
}

func runRecallProbe(dbPath string, query string, scopeType string, scopeKey string, character string) {
	if !filepath.IsAbs(dbPath) {
		if absolute, err := filepath.Abs(dbPath); err == nil {
			dbPath = absolute
		}
	}
	database, err := store.OpenReadOnly(dbPath)
	if err != nil {
		fail("打开记忆库失败: %v", err)
	}
	defer database.Close()
	entries, err := database.RecallMemory(store.NamespaceOptions{
		ScopeType:     scopeType,
		ScopeKey:      scopeKey,
		CharacterName: character,
	}, query, store.DefaultRecallOptions)
	if err != nil {
		fail("召回失败: %v", err)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(entries); err != nil {
		fail("输出失败: %v", err)
	}
}

func runSearchProbe(rootDir string, query string, limit int, fetchURL string) {
	document, err := config.Load(filepath.Join(rootDir, "config.json"))
	if err != nil {
		fail("读取配置失败: %v", err)
	}
	logger := log.New(os.Stdout, "", log.LstdFlags)
	searchConfig := tools.LoadSearchConfig(document)
	service := search.New(searchConfig, logger)

	if fetchURL != "" {
		page, err := service.FetchPage(context.Background(), fetchURL, 0)
		if err != nil {
			fail("抓取失败: %v", err)
		}
		fmt.Printf("标题: %s\n地址: %s\n字符数: %d（截断=%v）\n\n%s\n", page.Title, page.URL, page.Chars, page.Truncated, page.Text)
		return
	}

	startedAt := time.Now()
	results, attempted, err := service.Search(context.Background(), query, search.Request{Limit: limit})
	if err != nil {
		fail("搜索失败（已尝试 %v）: %v", attempted, err)
	}
	fmt.Printf("关键词: %s\n尝试: %v\n耗时: %dms\n结果: %d 条\n\n", query, attempted, time.Since(startedAt).Milliseconds(), len(results))
	for index, item := range results {
		fmt.Printf("%d. %s\n   %s\n   %s\n", index+1, item.Title, item.URL, item.Snippet)
	}
}

func runBot(rootDir string) error {
	document, err := config.Load(filepath.Join(rootDir, "config.json"))
	if err != nil {
		return err
	}
	dataDir := document.String("chat.dataDir")
	if dataDir == "" {
		dataDir = filepath.Join(rootDir, "data")
	} else if !filepath.IsAbs(dataDir) {
		dataDir = filepath.Join(rootDir, dataDir)
	}

	memoryPath := document.String("bindings.global.memoryDbPath")
	if memoryPath == "" {
		memoryPath = document.String("memory.storage.path")
	}
	if memoryPath == "" {
		memoryPath = filepath.Join(dataDir, "chats", "memory-store.sqlite")
	} else if !filepath.IsAbs(memoryPath) {
		memoryPath = filepath.Join(rootDir, memoryPath)
	}
	if err := os.MkdirAll(filepath.Dir(memoryPath), 0o755); err != nil {
		return err
	}
	memory, err := store.Open(memoryPath)
	if err != nil {
		return fmt.Errorf("打开记忆库失败: %w", err)
	}
	defer memory.Close()
	if err := memory.EnsureSchema(); err != nil {
		return fmt.Errorf("初始化记忆库失败: %w", err)
	}

	provider, err := ai.ResolveProvider(document)
	if err != nil {
		return err
	}
	logger := log.New(os.Stdout, "", log.LstdFlags)
	logger.Printf("模型: %s @ %s (provider=%s)", provider.Model, provider.BaseURL, provider.ID)

	client := onebot.New(onebot.Options{
		URL:         document.String("onebot.url"),
		AccessToken: document.String("onebot.accessToken"),
		TokenMode:   document.String("onebot.tokenMode"),
		Mode:        document.String("onebot.mode"),
		Logger:      logger,
	})

	searchConfig := tools.LoadSearchConfig(document)
	searchService := search.New(searchConfig, logger)
	toolRegistry := tools.New(searchService, logger)

	// MCP 客户端（stdio / http）
	var mcpRaw map[string]any
	if err := json.Unmarshal(document.Raw(), &mcpRaw); err == nil {
		if mcpSection, ok := mcpRaw["mcp"].(map[string]any); ok {
			mcpConfig := mcp.LoadConfig(mcpSection)
			if mcpConfig.Enabled && len(mcpConfig.Servers) > 0 {
				mcpClient := mcp.New(mcpConfig, logger)
				mcpClient.ConnectAll(context.Background())
				toolRegistry.AttachMCP(mcpClient)
				defer mcpClient.Close()
				logger.Printf("MCP: 已启用（%d 个服务器配置）", len(mcpConfig.Servers))
			} else {
				logger.Println("MCP: 未启用（mcp.client.enabled=false 或没有服务器）")
			}
		}
	}
	if searchConfig.Enabled {
		logger.Printf("联网搜索: 已启用（provider=%s，回退=%v，最多 %d 条）",
			searchConfig.Provider, searchConfig.FallbackProviders, searchConfig.MaxResults)
	} else {
		logger.Println("联网搜索: 未启用（ai.tools.webSearch.enabled=false）")
	}

	runtime := chat.New(chat.Options{
		Document: document,
		Memory:   memory,
		AI:       ai.New(provider),
		Bot:      client,
		Tools:    toolRegistry,
		Logger:   logger,
	})
	client.SetHandler(func(event map[string]any) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Printf("[聊天] 处理事件异常: %v", recovered)
			}
		}()
		runtime.HandleEvent(event)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		signalChannel := make(chan os.Signal, 1)
		signal.Notify(signalChannel, os.Interrupt, syscall.SIGTERM)
		<-signalChannel
		logger.Println("收到退出信号，正在停止 Bot…")
		client.Close()
		cancel()
	}()

	logger.Printf("MimirLink(Go) Bot 已启动，记忆库: %s", memoryPath)
	return client.Run(ctx)
}

func splitCategories(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, ",")
	result := make([]string, 0, len(parts))
	for _, item := range parts {
		if value := strings.TrimSpace(item); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

// truncateText 截断展示文本。
func truncateText(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
