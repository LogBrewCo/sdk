package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

type jsNativeArchive struct {
	name, digest, member string
}

func jsNativeArchiveForPlatform(platform string) (jsNativeArchive, bool) {
	var member, digest string
	switch platform {
	case "darwin/arm64":
		member = "oxlint-aarch64-apple-darwin"
		digest = "53b0cdbf1696b88293db648901a76785d5a3a4f98aeeb0a2be2b8d2eb8c44642"
	case "darwin/amd64":
		member = "oxlint-x86_64-apple-darwin"
		digest = "7cadde791a93b921429115594e71e47ab444ccdcbcbaae5a9a498cb52955aa3e"
	case "linux/arm64":
		member = "oxlint-aarch64-unknown-linux-gnu"
		digest = "c31f8b8b7e61924a3ac2a8d1223e34fe249baa4e0e7ba6a4984b96a946371aa2"
	case "linux/amd64":
		member = "oxlint-x86_64-unknown-linux-gnu"
		digest = "8ac22aebac95651eb64eff44d4abafeeee5bf606e6c943e3c6648de530c73255"
	default:
		return jsNativeArchive{name: "", digest: "", member: ""}, false
	}
	return jsNativeArchive{name: member + ".tar.gz", digest: digest, member: member}, true
}

func jsNativeArchiveContent(data []byte, specification jsNativeArchive) ([]byte, bool) {
	if len(data) == 0 || len(data) > markdownByteLimit || !directDirectoryName(specification.member) {
		return nil, false
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != specification.digest {
		return nil, false
	}
	compressed, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, false
	}
	content, valid := jsNativeTarContent(tar.NewReader(compressed), specification.member)
	drained, drainError := io.Copy(io.Discard, io.LimitReader(compressed, markdownByteLimit+1))
	closeError := compressed.Close()
	if !valid || drainError != nil || closeError != nil || drained > markdownByteLimit {
		return nil, false
	}
	return content, true
}

func jsNativeTarContent(archive *tar.Reader, name string) ([]byte, bool) {
	header, err := archive.Next()
	if err != nil || header.Name != name || header.Typeflag != tar.TypeReg ||
		header.Size <= 0 || header.Size > markdownByteLimit {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(archive, markdownByteLimit+1))
	if err != nil || int64(len(data)) != header.Size {
		return nil, false
	}
	_, err = archive.Next()
	return data, errors.Is(err, io.EOF)
}

func jsNativeReadArchive(root *os.Root, name string) ([]byte, bool) {
	file, err := openRootCheckInput(root, name)
	if err != nil {
		return nil, false
	}
	return readCheckInputLimit(file, markdownByteLimit)
}
