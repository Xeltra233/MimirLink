// Command mimir 是 MimirLink 的 Go 实现入口。
//
// 当前阶段（P2）提供数据盘点能力，用于验证 Go 版与 Node 版读写同一份数据：
//
//	go run ./cmd/mimir -check-data              # 人类可读摘要
//	go run ./cmd/mimir -check-data -json        # 机器可读 JSON（供 Node 侧对比）
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"mimirlink/internal/backup"
	"mimirlink/internal/config"
	"mimirlink/internal/datacheck"
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
