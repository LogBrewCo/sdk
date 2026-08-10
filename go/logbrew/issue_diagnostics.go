package logbrew

import (
	"math"
	"reflect"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxIssueStackFrames          = 32
	maxIssueBreadcrumbs          = 64
	maxIssueExceptions           = 8
	maxIssueExceptionTypeLength  = 256
	maxIssueExceptionMessage     = 1024
	maxIssueExceptionModule      = 512
	maxIssueMechanismTypeLength  = 64
	maxIssueStackFilenameLength  = 2048
	maxIssueStackFunctionLength  = 256
	maxIssueStackModuleLength    = 512
	maxIssueBreadcrumbNameLength = 64
	maxIssueBreadcrumbMessage    = 512
	maxIssueBreadcrumbDataFields = 8
	maxIssueBreadcrumbDataString = 256
	maxIssueStackCoordinate      = 2_147_483_647
)

var issueBreadcrumbLevelAliases = map[string]string{
	"trace":    "debug",
	"debug":    "debug",
	"info":     "info",
	"log":      "info",
	"warn":     "warning",
	"warning":  "warning",
	"error":    "error",
	"fatal":    "critical",
	"critical": "critical",
}

// IssueExceptionMechanism identifies the runtime path that observed an
// exception and whether the exception escaped that path.
type IssueExceptionMechanism struct {
	Type    string `json:"type"`
	Handled bool   `json:"handled"`
}

// IssueException is a privacy-bounded exception identity. It intentionally
// excludes the exception value; applications keep control of the issue
// Message field when a display-safe description is appropriate.
type IssueException struct {
	Type      string                   `json:"type"`
	Mechanism *IssueExceptionMechanism `json:"mechanism,omitempty"`
}

// IssueExceptionRelationship describes how a runtime exception relates to an
// earlier parent node.
type IssueExceptionRelationship string

const (
	IssueExceptionReported        IssueExceptionRelationship = "reported"
	IssueExceptionCause           IssueExceptionRelationship = "cause"
	IssueExceptionContext         IssueExceptionRelationship = "context"
	IssueExceptionAggregateMember IssueExceptionRelationship = "aggregate_member"
	IssueExceptionSuppressed      IssueExceptionRelationship = "suppressed"
)

// IssueExceptionMessageState reports whether one exception message was
// captured, truncated, redacted, or unavailable.
type IssueExceptionMessageState string

const (
	IssueExceptionMessageCaptured    IssueExceptionMessageState = "captured"
	IssueExceptionMessageTruncated   IssueExceptionMessageState = "truncated"
	IssueExceptionMessageRedacted    IssueExceptionMessageState = "redacted"
	IssueExceptionMessageNotCaptured IssueExceptionMessageState = "not_captured"
)

// IssueExceptionStackFramesState reports whether one exception stack was
// captured, truncated, or unavailable.
type IssueExceptionStackFramesState string

const (
	IssueExceptionStackFramesCaptured    IssueExceptionStackFramesState = "captured"
	IssueExceptionStackFramesTruncated   IssueExceptionStackFramesState = "truncated"
	IssueExceptionStackFramesNotCaptured IssueExceptionStackFramesState = "not_captured"
)

// IssueExceptionChainEntry is one parent-first runtime exception with its own
// bounded evidence states.
type IssueExceptionChainEntry struct {
	ID               int                            `json:"id"`
	ParentID         *int                           `json:"parentId,omitempty"`
	Relationship     IssueExceptionRelationship     `json:"relationship"`
	Type             string                         `json:"type"`
	Message          string                         `json:"message,omitempty"`
	MessageState     IssueExceptionMessageState     `json:"messageState"`
	Module           string                         `json:"module,omitempty"`
	Mechanism        *IssueExceptionMechanism       `json:"mechanism,omitempty"`
	StackFrames      []IssueStackFrame              `json:"stackFrames,omitempty"`
	StackFramesState IssueExceptionStackFramesState `json:"stackFramesState"`
}

// IssueExceptionChain contains at most eight parent-first runtime exceptions.
type IssueExceptionChain struct {
	Entries   []IssueExceptionChainEntry `json:"entries"`
	Truncated bool                       `json:"truncated"`
}

// IssueExceptionChainInput provides a runtime value and the matching legacy
// exception fields used to create one bounded chain.
type IssueExceptionChainInput struct {
	Value                any
	Exception            *IssueException
	StackFrames          []IssueStackFrame
	StackFramesTruncated bool
}

// IssueStackFrame is one structured code location. CaptureIssueStackFrames
// emits basename-only generated filenames and never includes source text,
// locals, or raw stack strings.
type IssueStackFrame struct {
	Filename string `json:"filename"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Function string `json:"function,omitempty"`
	Module   string `json:"module,omitempty"`
	InApp    *bool  `json:"inApp,omitempty"`
	DebugID  string `json:"debugId,omitempty"`
}

// IssueBreadcrumb is one application-supplied, privacy-bounded step that
// happened before an issue. Data accepts at most eight flat finite primitive
// values.
type IssueBreadcrumb struct {
	Timestamp string         `json:"timestamp"`
	Type      string         `json:"type,omitempty"`
	Category  string         `json:"category"`
	Level     string         `json:"level,omitempty"`
	Message   string         `json:"message,omitempty"`
	Data      map[string]any `json:"data,omitempty"`
}

// CaptureIssueStackFrames snapshots the current goroutine's call frames in
// newest-first order. It returns at most 32 validated frames with basename-only
// filenames and bounded function/module identities. It never captures source
// lines, local variables, raw stack text, or panic values.
func CaptureIssueStackFrames() []IssueStackFrame {
	return captureIssueStackEvidence(3).frames
}

type issueStackEvidence struct {
	frames    []IssueStackFrame
	truncated bool
}

func captureIssueStackEvidence(skip int) issueStackEvidence {
	pcs := make([]uintptr, maxIssueStackFrames*2)
	count := runtime.Callers(skip, pcs)
	if count == 0 {
		return issueStackEvidence{}
	}
	iterator := runtime.CallersFrames(pcs[:count])
	frames := make([]IssueStackFrame, 0, maxIssueStackFrames)
	truncated := false
	for len(frames) < maxIssueStackFrames {
		frame, more := iterator.Next()
		filename := sanitizeIssueStackFilename(frame.File, true)
		if !validIssueText(filename, maxIssueStackFilenameLength, false) || strings.ContainsAny(filename, "?#") {
			filename = "unknown.go"
		}
		line := frame.Line
		if line < 1 || line > maxIssueStackCoordinate {
			line = 1
		}
		functionName, moduleName := issueRuntimeIdentity(frame.Function)
		frames = append(frames, IssueStackFrame{
			Filename: filename,
			Line:     line,
			Column:   1,
			Function: functionName,
			Module:   moduleName,
		})
		if len(frames) == maxIssueStackFrames && more {
			truncated = true
		}
		if !more {
			break
		}
	}
	return issueStackEvidence{frames: frames, truncated: truncated}
}

// IssueAttributesFromError creates error-level issue attributes from a Go
// error. The root capture stack is bounded; unwrap nodes explicitly report
// that Go did not provide a separate stack. Error text is redacted by default.
func IssueAttributesFromError(err error, title string, mechanismType string, handled bool) (IssueAttributes, error) {
	if err == nil {
		return IssueAttributes{}, &SdkError{Code: "validation_error", Message: "issue error must be provided"}
	}
	if title == "" {
		title = safeGoExceptionType(err)
	}
	if mechanismType == "" {
		mechanismType = "go.error"
	}
	stack := captureIssueStackEvidence(3)
	exception := &IssueException{
		Type: safeGoExceptionType(err),
		Mechanism: &IssueExceptionMechanism{
			Type:    mechanismType,
			Handled: handled,
		},
	}
	chain, chainErr := CreateIssueExceptionChain(IssueExceptionChainInput{
		Value:                err,
		Exception:            exception,
		StackFrames:          stack.frames,
		StackFramesTruncated: stack.truncated,
	})
	if chainErr != nil {
		return IssueAttributes{}, chainErr
	}
	return IssueAttributes{
		Title:          title,
		Level:          "error",
		Exception:      exception,
		ExceptionChain: chain,
		StackFrames:    stack.frames,
	}, nil
}

// CreateIssueExceptionChain builds a bounded parent-first chain from a Go
// error or recovered panic value without reading or serializing its text.
func CreateIssueExceptionChain(input IssueExceptionChainInput) (*IssueExceptionChain, error) {
	if input.Exception == nil {
		return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain exception must be provided"}
	}
	if _, err := cloneIssueException(input.Exception); err != nil {
		return nil, err
	}
	if input.StackFrames != nil {
		if _, err := cloneIssueStackFrames(input.StackFrames); err != nil {
			return nil, err
		}
	}
	builder := issueExceptionChainBuilder{seen: make([]error, 0, maxIssueExceptions)}
	builder.addRoot(input)
	chain := &IssueExceptionChain{Entries: builder.entries, Truncated: builder.truncated}
	if _, err := cloneIssueExceptionChain(chain, input.Exception, input.StackFrames); err != nil {
		return nil, err
	}
	return chain, nil
}

type issueExceptionChainBuilder struct {
	entries   []IssueExceptionChainEntry
	seen      []error
	truncated bool
}

func (b *issueExceptionChainBuilder) addRoot(input IssueExceptionChainInput) {
	entry := IssueExceptionChainEntry{
		ID:               0,
		Relationship:     IssueExceptionReported,
		Type:             input.Exception.Type,
		MessageState:     IssueExceptionMessageNotCaptured,
		Mechanism:        input.Exception.Mechanism,
		StackFrames:      input.StackFrames,
		StackFramesState: issueStackState(input.StackFrames, input.StackFramesTruncated),
	}
	if input.Value != nil {
		entry.MessageState = IssueExceptionMessageRedacted
	}
	if errValue, ok := input.Value.(error); ok && errValue != nil {
		entry.Module = safeGoExceptionModule(errValue)
		b.seen = append(b.seen, errValue)
	}
	b.entries = append(b.entries, entry)
	if errValue, ok := input.Value.(error); ok && errValue != nil {
		b.addChildren(errValue, 0)
	}
}

func (b *issueExceptionChainBuilder) addChildren(parent error, parentID int) {
	children, relationship := safeGoErrorChildren(parent)
	for _, child := range children {
		if child == nil {
			continue
		}
		if seenGoError(b.seen, child) {
			b.truncated = true
			continue
		}
		if len(b.entries) >= maxIssueExceptions {
			b.truncated = true
			return
		}
		b.seen = append(b.seen, child)
		id := len(b.entries)
		parentCopy := parentID
		mechanismType := "go.unwrap"
		if relationship == IssueExceptionAggregateMember {
			mechanismType = "go.aggregate_member"
		}
		b.entries = append(b.entries, IssueExceptionChainEntry{
			ID:           id,
			ParentID:     &parentCopy,
			Relationship: relationship,
			Type:         safeGoExceptionType(child),
			MessageState: IssueExceptionMessageRedacted,
			Module:       safeGoExceptionModule(child),
			Mechanism: &IssueExceptionMechanism{
				Type:    mechanismType,
				Handled: true,
			},
			StackFramesState: IssueExceptionStackFramesNotCaptured,
		})
		b.addChildren(child, id)
	}
}

func issueStackState(frames []IssueStackFrame, truncated bool) IssueExceptionStackFramesState {
	if len(frames) == 0 {
		return IssueExceptionStackFramesNotCaptured
	}
	if truncated {
		return IssueExceptionStackFramesTruncated
	}
	return IssueExceptionStackFramesCaptured
}

func safeGoErrorChildren(err error) (children []error, relationship IssueExceptionRelationship) {
	defer func() {
		if recover() != nil {
			children = nil
			relationship = IssueExceptionCause
		}
	}()
	if multi, ok := err.(interface{ Unwrap() []error }); ok {
		return append([]error(nil), multi.Unwrap()...), IssueExceptionAggregateMember
	}
	if single, ok := err.(interface{ Unwrap() error }); ok {
		if child := single.Unwrap(); child != nil {
			return []error{child}, IssueExceptionCause
		}
	}
	return nil, IssueExceptionCause
}

func seenGoError(seen []error, candidate error) bool {
	candidateType := reflect.TypeOf(candidate)
	for _, existing := range seen {
		if reflect.TypeOf(existing) != candidateType {
			continue
		}
		if candidateType != nil && candidateType.Comparable() {
			if existing == candidate {
				return true
			}
			continue
		}
		existingValue := reflect.ValueOf(existing)
		candidateValue := reflect.ValueOf(candidate)
		switch candidateValue.Kind() {
		case reflect.Chan, reflect.Func, reflect.Map, reflect.Ptr, reflect.Slice, reflect.UnsafePointer:
			if existingValue.Pointer() == candidateValue.Pointer() {
				return true
			}
		}
	}
	return false
}

func safeGoExceptionType(value any) string {
	valueType := reflect.TypeOf(value)
	if valueType == nil {
		return "error"
	}
	typeName := valueType.String()
	if !validIssueText(typeName, maxIssueExceptionTypeLength, true) {
		return "error"
	}
	return typeName
}

// IssueExceptionType returns a bounded type identity for an error or recovered
// panic value without formatting or reading that value.
func IssueExceptionType(value any) string {
	return safeGoExceptionType(value)
}

func safeGoExceptionModule(err error) string {
	valueType := reflect.TypeOf(err)
	for valueType != nil && valueType.Kind() == reflect.Ptr {
		valueType = valueType.Elem()
	}
	if valueType == nil || !validIssueText(valueType.PkgPath(), maxIssueExceptionModule, true) {
		return ""
	}
	return valueType.PkgPath()
}

func cloneIssueException(exception *IssueException) (map[string]any, error) {
	if !validIssueText(exception.Type, maxIssueExceptionTypeLength, true) {
		return nil, &SdkError{Code: "validation_error", Message: "issue exception type is invalid or exceeds 256 characters"}
	}
	validated := map[string]any{"type": exception.Type}
	if exception.Mechanism != nil {
		if !validIssueMachineName(exception.Mechanism.Type, maxIssueMechanismTypeLength, true) {
			return nil, &SdkError{Code: "validation_error", Message: "issue exception mechanism type must be a stable machine name"}
		}
		validated["mechanism"] = map[string]any{
			"type":    exception.Mechanism.Type,
			"handled": exception.Mechanism.Handled,
		}
	}
	return validated, nil
}

func cloneIssueExceptionChain(
	chain *IssueExceptionChain,
	legacyException *IssueException,
	legacyFrames []IssueStackFrame,
) (map[string]any, error) {
	if chain == nil || len(chain.Entries) < 1 || len(chain.Entries) > maxIssueExceptions {
		return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain entries must contain 1-8 exceptions"}
	}
	entries := make([]map[string]any, 0, len(chain.Entries))
	for index := range chain.Entries {
		entry := chain.Entries[index]
		if entry.ID != index {
			return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain ids must be contiguous and match array order"}
		}
		if index == 0 {
			if entry.Relationship != IssueExceptionReported || entry.ParentID != nil {
				return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain entry 0 must be the parentless reported exception"}
			}
		} else if entry.Relationship == IssueExceptionReported || !validIssueExceptionRelationship(entry.Relationship) ||
			entry.ParentID == nil || *entry.ParentID < 0 || *entry.ParentID >= index {
			return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain parent relationship is invalid"}
		}
		if !validIssueText(entry.Type, maxIssueExceptionTypeLength, true) {
			return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain type is invalid or exceeds 256 characters"}
		}
		value := map[string]any{
			"id":               entry.ID,
			"relationship":     string(entry.Relationship),
			"type":             entry.Type,
			"messageState":     string(entry.MessageState),
			"stackFramesState": string(entry.StackFramesState),
		}
		if entry.ParentID != nil {
			value["parentId"] = *entry.ParentID
		}
		if entry.MessageState == IssueExceptionMessageCaptured || entry.MessageState == IssueExceptionMessageTruncated {
			if !validIssueText(entry.Message, maxIssueExceptionMessage, false) {
				return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain message must match messageState"}
			}
			value["message"] = entry.Message
		} else if (entry.MessageState != IssueExceptionMessageRedacted && entry.MessageState != IssueExceptionMessageNotCaptured) || entry.Message != "" {
			return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain message must match messageState"}
		}
		if entry.Module != "" {
			if !validIssueText(entry.Module, maxIssueExceptionModule, true) {
				return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain module is invalid or exceeds 512 characters"}
			}
			value["module"] = entry.Module
		}
		if entry.Mechanism != nil {
			mechanism, err := cloneIssueException(&IssueException{Type: entry.Type, Mechanism: entry.Mechanism})
			if err != nil {
				return nil, err
			}
			value["mechanism"] = mechanism["mechanism"]
		}
		if entry.StackFramesState == IssueExceptionStackFramesCaptured || entry.StackFramesState == IssueExceptionStackFramesTruncated {
			frames, err := cloneIssueStackFrames(entry.StackFrames)
			if err != nil {
				return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain stackFrames must match stackFramesState"}
			}
			value["stackFrames"] = frames
		} else if entry.StackFramesState != IssueExceptionStackFramesNotCaptured || entry.StackFrames != nil {
			return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain stackFrames must match stackFramesState"}
		}
		entries = append(entries, value)
	}
	if legacyException == nil {
		return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain reported exception must match exception"}
	}
	legacy, err := cloneIssueException(legacyException)
	if err != nil {
		return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain reported exception must match exception"}
	}
	reportedException := map[string]any{"type": entries[0]["type"]}
	if mechanism, ok := entries[0]["mechanism"]; ok {
		reportedException["mechanism"] = mechanism
	}
	if !reflect.DeepEqual(reportedException, legacy) {
		return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain reported exception must match exception"}
	}
	if chain.Entries[0].StackFramesState == IssueExceptionStackFramesNotCaptured {
		if legacyFrames != nil {
			return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain reported stack must match stackFrames"}
		}
	} else {
		legacyMapped, mapErr := cloneIssueStackFrames(legacyFrames)
		if mapErr != nil || !reflect.DeepEqual(entries[0]["stackFrames"], legacyMapped) {
			return nil, &SdkError{Code: "validation_error", Message: "issue exceptionChain reported stack must match stackFrames"}
		}
	}
	return map[string]any{"entries": entries, "truncated": chain.Truncated}, nil
}

func validIssueExceptionRelationship(value IssueExceptionRelationship) bool {
	switch value {
	case IssueExceptionCause, IssueExceptionContext, IssueExceptionAggregateMember, IssueExceptionSuppressed:
		return true
	default:
		return false
	}
}

func cloneIssueStackFrames(frames []IssueStackFrame) ([]map[string]any, error) {
	if len(frames) < 1 || len(frames) > maxIssueStackFrames {
		return nil, &SdkError{Code: "validation_error", Message: "issue stackFrames must contain 1-32 frames"}
	}
	validated := make([]map[string]any, 0, len(frames))
	for _, frame := range frames {
		filename := sanitizeIssueStackFilename(frame.Filename, false)
		if !validIssueText(filename, maxIssueStackFilenameLength, false) || strings.ContainsAny(filename, "?#") {
			return nil, &SdkError{Code: "validation_error", Message: "issue stack frame filename is invalid"}
		}
		if frame.Line < 1 || frame.Line > maxIssueStackCoordinate {
			return nil, &SdkError{Code: "validation_error", Message: "issue stack frame line must be a positive integer"}
		}
		if frame.Column < 1 || frame.Column > maxIssueStackCoordinate {
			return nil, &SdkError{Code: "validation_error", Message: "issue stack frame column must be a positive integer"}
		}
		value := map[string]any{
			"filename": filename,
			"line":     frame.Line,
			"column":   frame.Column,
		}
		if frame.Function != "" {
			if !validIssueText(frame.Function, maxIssueStackFunctionLength, false) {
				return nil, &SdkError{Code: "validation_error", Message: "issue stack frame function is invalid or exceeds 256 characters"}
			}
			value["function"] = frame.Function
		}
		if frame.Module != "" {
			if !validIssueText(frame.Module, maxIssueStackModuleLength, true) {
				return nil, &SdkError{Code: "validation_error", Message: "issue stack frame module is invalid or exceeds 512 characters"}
			}
			value["module"] = frame.Module
		}
		if frame.InApp != nil {
			value["inApp"] = *frame.InApp
		}
		if frame.DebugID != "" {
			debugID := strings.ToLower(strings.TrimSpace(frame.DebugID))
			if !validIssueDebugID(debugID) {
				return nil, &SdkError{Code: "validation_error", Message: "issue stack frame debugId is invalid"}
			}
			value["debugId"] = debugID
		}
		validated = append(validated, value)
	}
	return validated, nil
}

func cloneIssueBreadcrumbs(breadcrumbs []IssueBreadcrumb) ([]map[string]any, error) {
	if len(breadcrumbs) < 1 || len(breadcrumbs) > maxIssueBreadcrumbs {
		return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumbs must contain 1-64 entries"}
	}
	validated := make([]map[string]any, 0, len(breadcrumbs))
	for _, breadcrumb := range breadcrumbs {
		if !validIssueRFC3339Timestamp(breadcrumb.Timestamp) {
			return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb timestamp must be RFC 3339 with an explicit timezone"}
		}
		if !validIssueMachineName(breadcrumb.Category, maxIssueBreadcrumbNameLength, true) {
			return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb category must be a stable machine name"}
		}
		value := map[string]any{
			"timestamp": breadcrumb.Timestamp,
			"category":  breadcrumb.Category,
		}
		if breadcrumb.Type != "" {
			if !validIssueMachineName(breadcrumb.Type, maxIssueBreadcrumbNameLength, true) {
				return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb type must be a stable machine name"}
			}
			value["type"] = breadcrumb.Type
		}
		if breadcrumb.Level != "" {
			level, ok := issueBreadcrumbLevelAliases[breadcrumb.Level]
			if !ok {
				return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb level must be one of: trace, debug, info, log, warn, warning, error, fatal, critical"}
			}
			value["level"] = level
		}
		if breadcrumb.Message != "" {
			if !validIssueText(breadcrumb.Message, maxIssueBreadcrumbMessage, false) {
				return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb message is invalid or exceeds 512 characters"}
			}
			value["message"] = breadcrumb.Message
		}
		if breadcrumb.Data != nil {
			data, err := cloneIssueBreadcrumbData(breadcrumb.Data)
			if err != nil {
				return nil, err
			}
			value["data"] = data
		}
		validated = append(validated, value)
	}
	return validated, nil
}

func cloneIssueBreadcrumbData(data map[string]any) (map[string]any, error) {
	if len(data) > maxIssueBreadcrumbDataFields {
		return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb data must contain at most 8 fields"}
	}
	validated := make(map[string]any, len(data))
	for key, value := range data {
		if !validIssueMachineName(key, maxIssueBreadcrumbNameLength, false) {
			return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb data keys must be stable machine names"}
		}
		switch typed := value.(type) {
		case nil, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
			validated[key] = typed
		case float32:
			if math.IsNaN(float64(typed)) || math.IsInf(float64(typed), 0) {
				return nil, issueBreadcrumbPrimitiveError(key)
			}
			validated[key] = typed
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) {
				return nil, issueBreadcrumbPrimitiveError(key)
			}
			validated[key] = typed
		case string:
			if !validIssueText(typed, maxIssueBreadcrumbDataString, false) {
				return nil, &SdkError{Code: "validation_error", Message: "issue breadcrumb data value for " + key + " is invalid or exceeds 256 characters"}
			}
			validated[key] = typed
		default:
			return nil, issueBreadcrumbPrimitiveError(key)
		}
	}
	return validated, nil
}

func issueBreadcrumbPrimitiveError(key string) error {
	return &SdkError{Code: "validation_error", Message: "issue breadcrumb data value for " + key + " must be a finite primitive"}
}

func validIssueText(value string, maximum int, rejectLocationText bool) bool {
	if value == "" || strings.TrimSpace(value) == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximum {
		return false
	}
	if rejectLocationText && strings.ContainsAny(value, "?#") {
		return false
	}
	for _, character := range value {
		if character <= 31 || (character >= 127 && character <= 159) {
			return false
		}
	}
	return true
}

func validIssueMachineName(value string, maximum int, allowColon bool) bool {
	if len(value) < 1 || len(value) > maximum || !isASCIIAlpha(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if isASCIIAlpha(character) || (character >= '0' && character <= '9') ||
			character == '_' || character == '.' || character == '-' || (allowColon && character == ':') {
			continue
		}
		return false
	}
	return true
}

func isASCIIAlpha(value byte) bool {
	return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
}

func validIssueRFC3339Timestamp(value string) bool {
	if len(value) < 20 || value != strings.TrimSpace(value) ||
		value[4] != '-' || value[7] != '-' || value[10] != 'T' || value[13] != ':' || value[16] != ':' {
		return false
	}
	for _, index := range []int{0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18} {
		if !isASCIIDigit(value[index]) {
			return false
		}
	}
	timezoneIndex := 19
	if value[timezoneIndex] == '.' {
		timezoneIndex++
		fractionStart := timezoneIndex
		for timezoneIndex < len(value) && isASCIIDigit(value[timezoneIndex]) {
			timezoneIndex++
		}
		if timezoneIndex == fractionStart {
			return false
		}
	}
	if timezoneIndex >= len(value) {
		return false
	}
	switch value[timezoneIndex] {
	case 'Z':
		if timezoneIndex != len(value)-1 {
			return false
		}
	case '+', '-':
		if len(value)-timezoneIndex != 6 || value[timezoneIndex+3] != ':' ||
			!isASCIIDigit(value[timezoneIndex+1]) || !isASCIIDigit(value[timezoneIndex+2]) ||
			!isASCIIDigit(value[timezoneIndex+4]) || !isASCIIDigit(value[timezoneIndex+5]) {
			return false
		}
	default:
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func isASCIIDigit(value byte) bool {
	return value >= '0' && value <= '9'
}

func validIssueDebugID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index := 0; index < len(value); index++ {
		switch index {
		case 8, 13, 18, 23:
			if value[index] != '-' {
				return false
			}
		default:
			if hexValue(value[index]) < 0 {
				return false
			}
		}
	}
	return true
}

func sanitizeIssueStackFilename(value string, alwaysBasename bool) string {
	filename := strings.TrimSpace(value)
	fileURL := strings.HasPrefix(filename, "file://")
	if fileURL {
		filename = strings.TrimPrefix(filename, "file://")
	}
	if index := strings.IndexAny(filename, "?#"); index >= 0 {
		filename = filename[:index]
	}
	absolute := fileURL || strings.HasPrefix(filename, "/") || strings.HasPrefix(filename, `\`) ||
		(len(filename) >= 3 && isASCIIAlpha(filename[0]) && filename[1] == ':' && (filename[2] == '/' || filename[2] == '\\'))
	if alwaysBasename || absolute {
		filename = strings.ReplaceAll(filename, `\`, "/")
		if index := strings.LastIndex(filename, "/"); index >= 0 {
			filename = filename[index+1:]
		}
	}
	return filename
}

func issueRuntimeIdentity(value string) (functionName string, moduleName string) {
	identity := strings.TrimSpace(value)
	if identity == "" || strings.ContainsAny(identity, "?#\\") {
		return "", ""
	}
	lastSlash := strings.LastIndex(identity, "/")
	leaf := identity
	prefix := ""
	if lastSlash >= 0 {
		leaf = identity[lastSlash+1:]
		prefix = identity[:lastSlash+1]
	}
	dot := strings.Index(leaf, ".")
	if dot <= 0 || dot == len(leaf)-1 {
		return "", safeIssueRuntimeIdentity(identity, maxIssueStackModuleLength, true)
	}
	moduleName = safeIssueRuntimeIdentity(prefix+leaf[:dot], maxIssueStackModuleLength, true)
	functionName = safeIssueRuntimeIdentity(leaf[dot+1:], maxIssueStackFunctionLength, false)
	if strings.ContainsAny(functionName, "/\\?#") {
		functionName = ""
	}
	return functionName, moduleName
}

func safeIssueRuntimeIdentity(value string, maximum int, rejectLocationText bool) string {
	if !validIssueText(value, maximum, rejectLocationText) {
		return ""
	}
	return strings.TrimSpace(value)
}
