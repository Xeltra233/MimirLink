package store

import "os"

func mkdirAll(path string) error { return os.MkdirAll(path, 0o755) }

func writeFile(path string, content string) error { return os.WriteFile(path, []byte(content), 0o644) }
