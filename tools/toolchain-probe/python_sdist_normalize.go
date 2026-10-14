package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	pythonMaximumEpoch       = 4294967295
	pythonNormalizedFileMode = 0o644
	pythonTemporaryFileMode  = 0o600
	pythonNormalizeMode      = "normalize-sdist"
)

func runPythonSdistNormalize(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 3 || !filepath.IsAbs(arguments[1]) || !strings.HasSuffix(arguments[1], ".tar.gz") {
		return writeText(diagnostic, "normalize-sdist requires an absolute source package and epoch\n", exitUsage)
	}
	epoch, err := strconv.ParseInt(arguments[2], 10, 64)
	if err != nil || epoch < 0 || epoch > pythonMaximumEpoch {
		return writeText(diagnostic, "invalid source date epoch\n", exitUsage)
	}
	if !normalizePythonSdistFile(arguments[1], epoch) {
		return writeText(diagnostic, "source package normalization failed\n", exitFailure)
	}
	return writeText(output, "{\"scope\":\"python_sdist_normalized\",\"valid\":true}\n", exitOK)
}

func normalizePythonSdist(data []byte, epoch int64) ([]byte, bool) {
	if epoch < 0 || epoch > pythonMaximumEpoch {
		return nil, false
	}
	entries, valid := readPythonArchive(data, pythonSdist)
	if !valid {
		return nil, false
	}
	var output bytes.Buffer
	compressed, err := gzip.NewWriterLevel(&output, gzip.BestCompression)
	if err != nil {
		return nil, false
	}
	compressed.ModTime = time.Unix(epoch, 0).UTC()
	writer := tar.NewWriter(compressed)
	written := writeNormalizedPythonEntries(writer, entries, epoch)
	tarError := writer.Close()
	gzipError := compressed.Close()
	if !written || tarError != nil || gzipError != nil {
		return nil, false
	}
	verified, valid := readPythonArchive(output.Bytes(), pythonSdist)
	if !valid || pythonArchiveDigest(verified) != pythonArchiveDigest(entries) {
		return nil, false
	}
	return output.Bytes(), true
}

func writeNormalizedPythonEntries(writer *tar.Writer, entries []pythonArchiveEntry, epoch int64) bool {
	for _, entry := range entries {
		header := new(tar.Header)
		header.Name, header.Mode, header.Size = entry.name, int64(entry.mode), int64(len(entry.data))
		header.ModTime = time.Unix(epoch, 0).UTC()
		header.Typeflag, header.Format = tar.TypeReg, tar.FormatPAX
		if entry.directory {
			header.Typeflag, header.Size = tar.TypeDir, 0
		}
		if err := writer.WriteHeader(header); err != nil {
			return false
		}
		if _, err := writer.Write(entry.data); err != nil {
			return false
		}
	}
	return true
}

// Only replace a regular source-package file after its normalized bytes have
// passed the same archive/content checks. Never extract a member to disk.
func normalizePythonSdistFile(filename string, epoch int64) bool {
	if !filepath.IsAbs(filename) || !strings.HasSuffix(filename, ".tar.gz") {
		return false
	}
	root, err := os.OpenRoot(filepath.Dir(filename))
	if err != nil {
		return false
	}
	normalized := normalizePythonSdistAtRoot(root, filepath.Base(filename), epoch)
	closeError := root.Close()
	return normalized && closeError == nil
}

func normalizePythonSdistAtRoot(root *os.Root, name string, epoch int64) bool {
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	input, err := openRootCheckInput(root, name)
	if err != nil {
		return false
	}
	data, valid := readCheckInputFile(input)
	if !valid {
		return false
	}
	normalized, valid := normalizePythonSdist(data, epoch)
	if !valid {
		return false
	}
	return replacePythonOutput(root, name, normalized, pythonNormalizedFileMode)
}
