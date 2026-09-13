package backup

import (
	"archive/tar"
	"compress/gzip"
	"io"
)

// 测试用的极简 tar 写入器（构造非法归档以验证路径穿越防护）
type writerForTest struct {
	tarWriter *tar.Writer
	gzip      *gzip.Writer
}

func newWriterForTest(target io.Writer) *writerForTest {
	gzipWriter := gzip.NewWriter(target)
	return &writerForTest{tarWriter: tar.NewWriter(gzipWriter), gzip: gzipWriter}
}

func (w *writerForTest) addFile(name string, content string) error {
	header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}
	if err := w.tarWriter.WriteHeader(header); err != nil {
		return err
	}
	_, err := w.tarWriter.Write([]byte(content))
	return err
}

func (w *writerForTest) close() error {
	if err := w.tarWriter.Close(); err != nil {
		return err
	}
	return w.gzip.Close()
}
