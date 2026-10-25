package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	nativeUploader     = "logbrew-native-release-artifact-upload-verifier"
	nativeUploadUsage  = "usage: release-artifacts native-upload --artifact-root DIR --manifest FILE --endpoint URL [options]\n"
	uploadTokenDefault = "LOGBREW_RELEASE_ARTIFACT_TOKEN"
)

// uploadInvalid is a check that fails before upload and is reported as
// validation_failed.
type uploadInvalid string

func (err uploadInvalid) Error() string { return string(err) }

// uploadOptions holds the native-upload options after parsing.
type uploadOptions struct {
	root, manifest, endpoint, tokenEnvironment string
	dryRun                                     bool
	retries                                    int64
	delay, timeout                             float64
}

// checkNativeUpload uploads the files of a ready native debug symbol manifest
// to a loopback intake, retrying retryable failures, and prints a report.
func checkNativeUpload(arguments []string, transport http.RoundTripper, output, diagnostic io.Writer) (code int) {
	flags := flag.NewFlagSet("native-upload", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	options := uploadOptions{}
	flags.StringVar(&options.root, "artifact-root", "", "")
	flags.StringVar(&options.manifest, "manifest", "", "")
	flags.StringVar(&options.endpoint, "endpoint", "", "")
	flags.StringVar(&options.tokenEnvironment, "token-env", uploadTokenDefault, "")
	flags.BoolVar(&options.dryRun, "dry-run", false, "")
	retries, delay, timeout := flags.String("max-retries", "2", ""), flags.String("retry-delay", "0.25", ""),
		flags.String("timeout", "5", "")
	err := flags.Parse(arguments)
	set := map[string]bool{}
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	for _, name := range []string{"artifact-root", "manifest", "endpoint"} {
		err = requireFlag(err, set[name])
	}
	if errors.Is(err, flag.ErrHelp) {
		return writeText(output, nativeUploadUsage, exitOK)
	}
	var parsed [3]bool
	options.retries, parsed[0] = pyInt(*retries, 10, false)
	options.delay, parsed[1] = pyFloat(*delay)
	options.timeout, parsed[2] = pyFloat(*timeout)
	if err != nil || flags.NArg() > 0 || parsed != [3]bool{true, true, true} || options.retries < 0 ||
		options.delay < 0 || options.timeout < 0 {
		return writeText(diagnostic, nativeUploadUsage, exitUsage)
	}
	defer func() {
		if value := recover(); value != nil {
			stop := value.(nativeStop)
			code = writeText(diagnostic, stop.message+"\n", stop.code)
		}
	}()
	report, manifest, files, err := nativeUploadPlan(options)
	var invalid uploadInvalid
	if errors.As(err, &invalid) {
		return jsPrint(output, map[string]any{"status": "validation_failed", "validation": map[string]any{
			"errors": []string{err.Error()}}, "uploader": map[string]any{"name": nativeUploader, "version": jsArtifactVersion}},
			exitFailure)
	}
	if err != nil {
		panic(nativeStop{exitFailure, err.Error()})
	}
	token := pyStrip(os.Getenv(options.tokenEnvironment))
	switch {
	case options.dryRun:
		report["status"], report["attempts"], report["retryCount"] = "dry_run", []any{}, 0
	case token == "":
		report["status"], report["attempts"], report["retryCount"] = "auth_missing", []any{}, 0
	default:
		attempts := uploadWithRetries(options, transport, token, manifest, files)
		report["status"], report["attempts"], report["retryCount"] = attempts[len(attempts)-1]["result"], attempts,
			len(attempts)-1
	}
	exit, known := map[any]int{"uploaded": 0, "dry_run": 0, "auth_missing": 2, "auth_failed": 3,
		"validation_failed": 4}[report["status"]]
	return jsPrint(output, report, map[bool]int{true: exit, false: 5}[known])
}

// nativeUploadPlan checks the endpoint, manifest, and files, returning the
// report, the manifest, and the files to upload with their part names.
func nativeUploadPlan(options uploadOptions) (map[string]any, map[string]any, [][2]string, error) {
	parts, err := pyURLSplit(options.endpoint)
	if err != nil {
		return nil, nil, nil, err
	}
	host, port := pyURLHost(parts.netloc)
	address, addressError := netip.ParseAddr(host)
	if parts.scheme != "http" && parts.scheme != "https" || host != "localhost" &&
		(addressError != nil || !address.IsLoopback()) {
		return nil, nil, nil, uploadInvalid("release artifact upload proof endpoint must be loopback-only unless the " +
			"verifier exposes explicit hosted upload opt-in")
	}
	root, _ := pyRealpath(pyPurePath(options.root))
	if !pyIsDir(root) {
		return nil, nil, nil, uploadInvalid("artifact root does not exist: " + root)
	}
	manifest, problem, err := readJSONObject(pyPurePath(options.manifest), "manifest")
	switch {
	case err != nil:
		return nil, nil, nil, err
	case problem != "":
		return nil, nil, nil, uploadInvalid(problem)
	}
	validation, _ := manifest["validation"].(map[string]any)
	artifacts, _ := manifest["artifacts"].([]any)
	switch {
	case manifest["artifactType"] != "native_debug_symbol_manifest":
		return nil, nil, nil, uploadInvalid("only native_debug_symbol_manifest uploads are supported by this verifier")
	case validation["status"] != "ready":
		return nil, nil, nil, uploadInvalid("manifest validation status must be ready before upload")
	case len(artifacts) == 0:
		return nil, nil, nil, uploadInvalid("manifest must contain at least one native/mobile release artifact")
	}
	files, types, total := [][2]string{}, []any{}, int64(0)
	for index, value := range artifacts {
		artifact, isObject := value.(map[string]any)
		if !isObject {
			return nil, nil, nil, uploadInvalid("artifact entries must be JSON objects")
		}
		paths, err := nativeArtifactFiles(artifact, root)
		if err != nil {
			return nil, nil, nil, err
		}
		for file, path := range paths {
			files = append(files, [2]string{fmt.Sprintf("artifact_%d_file_%d", index, file), path})
		}
		size, _ := strconv.ParseInt(string(artifact["byteSize"].(json.Number)), 10, 64)
		types, total = append(types, artifact["artifactType"]), total+size
	}
	if port != "" {
		if strings.Trim(port, "0123456789") != "" {
			return nil, nil, nil, pyValueError("Port could not be cast to integer value as " + pyString(port))
		}
		number, err := strconv.Atoi(port)
		if err != nil || number > math.MaxUint16 {
			return nil, nil, nil, pyValueError("Port out of range 0-65535")
		}
		port = ":" + strconv.Itoa(number)
	}
	return map[string]any{"dryRun": options.dryRun,
		"uploader": map[string]any{"name": nativeUploader, "version": jsArtifactVersion},
		"endpoint": parts.scheme + "://" + host + port + cmpOr(parts.path, "/"),
		"release":  manifest["release"], "environment": manifest["environment"], "service": manifest["service"],
		"artifactType": manifest["artifactType"], "artifactTypes": types, "artifactCount": len(artifacts),
		"filePartCount": len(files), "totalArtifactBytes": total}, manifest, files, nil
}

// pyURLHost returns the lowercased host, keeping any zone as is, and the port
// text of a netloc, as urlsplit reads them.
func pyURLHost(netloc string) (string, string) {
	host, port, _ := strings.Cut(netloc[strings.LastIndex(netloc, "@")+1:], ":")
	if _, bracketed, found := strings.Cut(netloc[strings.LastIndex(netloc, "@")+1:], "["); found {
		host, port, _ = strings.Cut(bracketed, "]")
		_, port, _ = strings.Cut(port, ":")
	}
	name, zone, hasZone := strings.Cut(host, "%")
	return strings.ToLower(name) + map[bool]string{true: "%" + zone}[hasZone], port
}

// nativeArtifactFiles checks one manifest artifact against the files under
// root and returns them.
func nativeArtifactFiles(artifact map[string]any, root string) ([]string, error) {
	for _, field := range []string{"path", "artifactSha256", "byteSize", "fileCount"} {
		if artifact[field] == nil || artifact[field] == "" {
			return nil, uploadInvalid("artifact is missing " + field)
		}
	}
	display := pyStr(artifact["path"])
	if validation, _ := artifact["validation"].(map[string]any); validation["status"] != "ready" {
		return nil, uploadInvalid("artifact validation status must be ready: " + display)
	}
	raw := pyPurePath(root + "/" + display)
	if strings.HasPrefix(display, "/") {
		raw = pyPurePath(display)
	}
	if relative := pyRelative(raw, root); relative != "" && relative != "." {
		current := root
		for _, part := range strings.Split(relative, "/") {
			if current += "/" + part; nativeLink(current) {
				return nil, uploadInvalid("artifact path uses a symbolic link: " + display)
			}
		}
	}
	path, inside := pySafeResolve(raw, root)
	switch {
	case !inside:
		return nil, uploadInvalid("artifact path resolves outside the artifact root")
	case !pyExists(path):
		return nil, uploadInvalid("artifact path is missing: " + display)
	case !nativeRegular(path) && !pyIsDir(path):
		return nil, uploadInvalid("artifact path is neither a file nor directory: " + display)
	}
	files := []string{path}
	if !nativeRegular(path) {
		files = []string{}
		for _, candidate := range nativeWalk(path) {
			if nativeLink(candidate) {
				return nil, uploadInvalid("artifact contains a symbolic link: " + pyRelative(candidate, root))
			}
			if nativeRegular(candidate) {
				files = append(files, candidate)
			}
		}
		if len(files) == 0 {
			return nil, uploadInvalid("artifact contains no regular files: " + display)
		}
	}
	size := int64(0)
	for _, file := range files {
		size += nativeSize(file)
	}
	for _, check := range []struct {
		field  string
		actual int64
		change string
	}{{"fileCount", int64(len(files)), "file count"}, {"byteSize", size, "byte size"}} {
		number, isNumber := artifact[check.field].(json.Number)
		value, err := strconv.ParseInt(string(number), 10, 64)
		if !isNumber || strings.ContainsAny(string(number), ".eE") || strings.HasPrefix(string(number), "-") &&
			string(number) != "-0" {
			return nil, uploadInvalid("artifact is missing valid " + check.field)
		}
		if err != nil || value != check.actual {
			return nil, uploadInvalid("artifact " + check.change + " changed after manifest creation: " + display)
		}
	}
	digest := sha256.New()
	for _, file := range files {
		fmt.Fprintf(digest, "%s\x00%s\x00%d\x00", pyRelative(file, root), nativeSHA256(file), nativeSize(file))
	}
	tree := hex.EncodeToString(digest.Sum(nil))
	if nativeRegular(path) {
		tree = nativeSHA256(path)
	}
	if pyStr(artifact["artifactSha256"]) != tree {
		return nil, uploadInvalid("artifact sha256 changed after manifest creation: " + display)
	}
	return files, nil
}

func nativeLink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

// uploadWithRetries posts the multipart upload until it succeeds, fails
// without retry, or uses its retries, returning each attempt.
func uploadWithRetries(options uploadOptions, transport http.RoundTripper, token string, manifest map[string]any,
	files [][2]string,
) []map[string]any {
	random := make([]byte, 16)
	_, _ = rand.Read(random)
	boundary := "logbrew-" + hex.EncodeToString(random)
	var body bytes.Buffer
	part := func(name, filename, contentType string, data []byte) {
		quote := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace
		fmt.Fprintf(&body, "--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"+
			"Content-Type: %s\r\n\r\n%s\r\n", boundary, quote(name), quote(filename), contentType, data)
	}
	text, _ := pyJSONText(manifest, "")
	part("manifest", "manifest.json", "application/json", []byte(strings.TrimSuffix(text, "\n")))
	for _, file := range files {
		data, err := os.ReadFile(file[1])
		if err != nil {
			panic(nativeStop{exitFailure, pyOSErrorText(err, file[1]).Error()})
		}
		part(file[0], pathBase(file[1]), "application/octet-stream", data)
	}
	fmt.Fprintf(&body, "--%s--\r\n", boundary)
	if !(options.timeout <= pyMaxSeconds) {
		panic(nativeStop{exitFailure, "invalid timeout: " + pyG(options.timeout)})
	}
	client := &http.Client{Transport: transport, Timeout: time.Duration(options.timeout * float64(time.Second)),
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	attempts := []map[string]any{}
	for attempt := int64(1); ; attempt++ {
		request, _ := http.NewRequest(http.MethodPost, options.endpoint, bytes.NewReader(body.Bytes()))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
		request.Header.Set("User-Agent", "logbrew-release-artifact-verifier/"+jsArtifactVersion)
		request.Header.Set("Accept-Encoding", "identity")
		result := map[string]any{"attempt": attempt, "result": "retryable_error"}
		// A zero timeout fails at once, like a nonblocking connect.
		response, err := (*http.Response)(nil), errors.New("timed out")
		if options.timeout > 0 {
			response, err = client.Do(request)
		}
		if err == nil {
			_, _ = io.CopyN(io.Discard, response.Body, 1024)
			_ = response.Body.Close()
			result["httpStatus"], result["result"] = response.StatusCode, uploadResult(response.StatusCode)
		}
		attempts = append(attempts, result)
		if result["result"] != "retryable_error" || attempt > options.retries {
			return attempts
		}
		if options.delay > 0 {
			if options.delay > pyMaxSeconds {
				panic(nativeStop{exitFailure, "invalid sleep length: " + pyG(options.delay)})
			}
			time.Sleep(time.Duration(options.delay * float64(time.Second)))
		}
	}
}

// uploadResult classifies an upload response status.
func uploadResult(status int) string {
	switch {
	case status >= 200 && status < 300:
		return "uploaded"
	case status == 401 || status == 403:
		return "auth_failed"
	case status == 400 || status == 413:
		return "validation_failed"
	case status == 408 || status == 429 || status >= 500:
		return "retryable_error"
	}
	return "upload_failed"
}
