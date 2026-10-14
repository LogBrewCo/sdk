package main

import "os"

func brandReadAsset(root *os.Root, name string, byteLimit int) ([]byte, bool) {
	if byteLimit < 0 || byteLimit > brandSVGByteLimit {
		return nil, false
	}
	file, err := openRootCheckInput(root, name)
	if err != nil {
		return nil, false
	}
	return readCheckInputLimit(file, int64(byteLimit))
}
