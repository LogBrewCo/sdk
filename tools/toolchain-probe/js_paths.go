package main

import (
	"cmp"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"os"
	"regexp"
	"strings"
	"syscall"

	"golang.org/x/text/unicode/norm"
)

// pyOSError carries the text of a Python OSError.
type pyOSError string

func (err pyOSError) Error() string { return string(err) }

// pyValueError carries the text of a Python ValueError.
type pyValueError string

func (err pyValueError) Error() string { return string(err) }

var ipvFuturePattern = regexp.MustCompile(`^v[a-fA-F0-9]+\..+$`)

// pyOSErrorText formats a failed file operation like str() of Python's OSError.
func pyOSErrorText(err error, name string) pyOSError {
	var number syscall.Errno
	errors.As(err, &number)
	text := number.Error()
	return pyOSError(fmt.Sprintf("[Errno %d] %s%s: %s", int(number), strings.ToUpper(text[:1]), text[1:], pyString(name)))
}

// pyWriteText writes text like Path.write_text.
func pyWriteText(path, text string) error {
	if err := os.WriteFile(path, []byte(text), 0o666); err != nil {
		return pyOSErrorText(err, path)
	}
	return nil
}

// pyReadText reads a file like Path.read_text with UTF-8, replacing invalid
// bytes, and with universal newlines.
func pyReadText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", pyOSErrorText(err, path)
	}
	return strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(pyUTF8(data)), nil
}

// pyRealpath resolves a path like Python's os.path.realpath without strict
// mode: missing parts stay as written and a symbolic link loop stops there.
func pyRealpath(path string) (string, error) {
	return pyResolve(path, false)
}

// pyResolve resolves a path like os.path.realpath; in strict mode a missing
// part or a symbolic link loop is an error, as in Path.resolve(strict=True).
func pyResolve(path string, strict bool) (string, error) {
	if strings.ContainsRune(path, 0) {
		return "", pyValueError("embedded null byte")
	}
	resolved := "/"
	if !strings.HasPrefix(path, "/") {
		resolved, _ = syscall.Getwd()
	}
	type part struct{ name, link string }
	stack, seen := []part{}, map[string]*string{}
	push := func(text string) {
		names := strings.Split(text, "/")
		for index := len(names) - 1; index >= 0; index-- {
			stack = append(stack, part{name: names[index]})
		}
	}
	for push(path); len(stack) > 0; {
		item := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if item.link != "" {
			target := resolved
			seen[item.link] = &target
			continue
		}
		switch item.name {
		case "", ".":
			continue
		case "..":
			resolved = cmpOr(resolved[:strings.LastIndex(resolved, "/")], "/")
			continue
		}
		next := strings.TrimSuffix(resolved, "/") + "/" + item.name
		info, err := os.Lstat(next)
		cached, found := seen[next]
		target, linkError := "", err
		if err == nil && info.Mode()&fs.ModeSymlink != 0 && !found {
			target, linkError = os.Readlink(next)
		}
		switch {
		case strict && (err != nil || linkError != nil || found && cached == nil):
			return "", cmp.Or(err, linkError, error(syscall.ELOOP))
		case err != nil || info.Mode()&fs.ModeSymlink == 0 || found && cached == nil || linkError != nil:
			resolved = next
		case found:
			resolved = *cached
		default:
			if strings.HasPrefix(target, "/") {
				resolved = "/"
			}
			seen[next] = nil
			stack = append(stack, part{link: next})
			push(target)
		}
	}
	return resolved, nil
}

// pySafeResolve resolves candidate and reports whether it stays inside root.
func pySafeResolve(candidate, root string) (string, bool) {
	resolved, err := pyRealpath(candidate)
	base, baseError := pyRealpath(root)
	return resolved, err == nil && baseError == nil && pyRelative(resolved, base) != ""
}

// pyRelative returns path relative to root like PurePath.relative_to, or ""
// when path is outside root.
func pyRelative(path, root string) string {
	switch {
	case path == root:
		return "."
	case strings.HasPrefix(path, strings.TrimSuffix(root, "/")+"/"):
		return path[len(strings.TrimSuffix(root, "/"))+1:]
	}
	return ""
}

func pyIsDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func pyExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// pyPurePath normalizes a path like pathlib, which keeps exactly two leading
// slashes.
func pyPurePath(path string) string {
	if strings.HasPrefix(path, "//") && !strings.HasPrefix(path, "///") {
		return "/" + pyPath(path)
	}
	return pyPath(path)
}

// pyNormpath normalizes a path like Python's posixpath.normpath.
func pyNormpath(path string) string {
	slashes := 0
	if strings.HasPrefix(path, "/") {
		slashes = 1
	}
	if strings.HasPrefix(path, "//") && !strings.HasPrefix(path, "///") {
		slashes = 2
	}
	parts := []string{}
	for _, part := range strings.Split(path, "/") {
		switch {
		case part == "" || part == ".":
		case part != ".." || slashes == 0 && len(parts) == 0 || len(parts) > 0 && parts[len(parts)-1] == "..":
			parts = append(parts, part)
		case len(parts) > 0:
			parts = parts[:len(parts)-1]
		}
	}
	return cmpOr(strings.Repeat("/", slashes)+strings.Join(parts, "/"), ".")
}

type pyURL struct{ scheme, netloc, path, query, fragment string }

// pyURLSplit splits a URL like Python's urllib.parse.urlsplit, including the
// ValueErrors it raises for invalid bracketed hosts and netlocs.
func pyURLSplit(url string) (pyURL, error) {
	url = strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(strings.TrimLeftFunc(url,
		func(character rune) bool { return character <= ' ' }))
	parts := pyURL{}
	if index := strings.IndexByte(url, ':'); index > 0 && 'a' <= url[0]|0x20 && url[0]|0x20 <= 'z' &&
		strings.Trim(url[:index], "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.") == "" {
		parts.scheme, url = strings.ToLower(url[:index]), url[index+1:]
	}
	if strings.HasPrefix(url, "//") {
		end := len(url)
		if index := strings.IndexAny(url[2:], "/?#"); index >= 0 {
			end = index + 2
		}
		parts.netloc, url = url[2:end], url[end:]
		if strings.ContainsAny(parts.netloc, "[]") && !pyBracketedHost(parts.netloc) {
			return parts, pyValueError("Invalid IPv6 URL")
		}
	}
	url, parts.fragment, _ = strings.Cut(url, "#")
	parts.path, parts.query, _ = strings.Cut(url, "?")
	if netloc := strings.NewReplacer("@", "", ":", "", "#", "", "?", "").Replace(parts.netloc); netloc != norm.NFKC.String(netloc) &&
		strings.ContainsAny(norm.NFKC.String(netloc), "/?#@:") {
		return parts, pyValueError("netloc '" + parts.netloc + "' contains invalid characters under NFKC normalization")
	}
	return parts, nil
}

// pyBracketedHost reports whether a netloc holds one bracketed IPv6 or
// IPvFuture host, optionally followed by a port.
func pyBracketedHost(netloc string) bool {
	prefix, host, _ := strings.Cut(netloc[strings.LastIndex(netloc, "@")+1:], "[")
	host, port, closed := strings.Cut(host, "]")
	address, err := netip.ParseAddr(host)
	return prefix == "" && closed && (port == "" || strings.HasPrefix(port, ":")) &&
		(ipvFuturePattern.MatchString(host) || err == nil && address.Is6() && strings.Count(host, "%") <= 1)
}

func pyHasNetloc(parts pyURL, text string) bool {
	return parts.scheme != "" && (parts.netloc != "" || strings.HasPrefix(text, parts.scheme+"://"))
}

// pyStr formats a decoded JSON value like Python's str().
func pyStr(value any) string {
	if text, isString := value.(string); isString {
		return text
	}
	return pyRepr(value)
}
