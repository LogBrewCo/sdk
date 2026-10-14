package main

import "slices"

const nugetPackageLimit = 50 << 20

// This digest identifies unpacked content without the root signature entry.
// It does not authenticate the signature or validate nuspec/source metadata.
func nugetPackageContentSHA256(data []byte) (string, bool) {
	entries, valid := nugetArchiveEntries(data)
	if !valid {
		return "", false
	}
	return nugetContentDigest(entries)
}

func nugetArchiveEntries(data []byte) ([]pythonArchiveEntry, bool) {
	if len(data) == 0 || len(data) > nugetPackageLimit {
		return nil, false
	}
	entries, valid := readPythonWheel(data)
	if !valid || !canonicalArchiveEntries(entries) {
		return nil, false
	}
	return entries, true
}

func nugetContentDigest(entries []pythonArchiveEntry) (string, bool) {
	entries = slices.DeleteFunc(entries, func(entry pythonArchiveEntry) bool { return entry.name == ".signature.p7s" })
	digest := framedArchiveDigest(entries)
	return digest, digest != ""
}
