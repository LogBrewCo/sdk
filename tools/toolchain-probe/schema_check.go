package main

import (
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	schemaCheckURL       = "https://example.invalid/selected.schema.json"
	schemaCheckArguments = 2
	schemaRegexpTimeout  = 50 * time.Millisecond
	schemaPatternLimit   = 4096
	schemaCheckMode      = "schema-check"
	eventBatchCheckMode  = "event-batch-check"
	expectInvalidOption  = "--expect-invalid"
	validationUsage      = "validation requires schema and input paths; " +
		"only event-batch-check accepts --expect-invalid\n"
)

var (
	errCheckSchema = errors.New("schema invalid or unavailable")
	errCheckInput  = errors.New("input invalid or unavailable")
	errCheckRegex  = errors.New("regex evaluation limit exceeded")
)

type checkedSchema struct {
	schema *jsonschema.Schema
	failed atomic.Bool
}

type schemaRegexp struct {
	expression *regexp2.Regexp
	failed     *atomic.Bool
}

func (expression schemaRegexp) String() string {
	return expression.expression.String()
}

func (expression schemaRegexp) MatchString(value string) bool {
	if expression.failed.Load() {
		return false
	}
	matched, err := expression.expression.MatchString(value)
	if err != nil {
		expression.failed.Store(true)
	}
	return err == nil && matched
}

// Reviewed 2026-09-05: RegexpEngine requires this interface-returning signature.
//
//nolint:ireturn // Canonical-schema, offline-reference, and timeout tests cover the returned adapter.
func (checker *checkedSchema) compileRegexp(pattern string) (jsonschema.Regexp, error) {
	if len(pattern) > schemaPatternLimit {
		return nil, errCheckRegex
	}
	expression, err := regexp2.Compile(pattern, regexp2.ECMAScript)
	if err != nil {
		return nil, errCheckSchema
	}
	expression.MatchTimeout = schemaRegexpTimeout
	return schemaRegexp{expression: expression, failed: &checker.failed}, nil
}

func compileCheckSchema(data []byte) (*checkedSchema, error) {
	document, valid := decodeSchemaDocument(data)
	if !valid {
		return nil, errCheckSchema
	}
	checker := new(checkedSchema)
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.UseLoader(nil) // Only this resource and embedded standard metaschemas are available.
	compiler.UseRegexpEngine(checker.compileRegexp)
	compiler.AssertFormat()
	compiler.AssertContent()
	compiler.AssertVocabs()
	if compiler.AddResource(schemaCheckURL, document) != nil {
		return nil, errCheckSchema
	}
	compiled, err := compiler.Compile(schemaCheckURL)
	if err != nil || checker.failed.Load() {
		return nil, errCheckSchema
	}
	checker.schema = compiled
	return checker, nil
}

func (checker *checkedSchema) validate(data []byte) (bool, error) {
	document, valid := decodeSchemaDocument(data)
	if !valid {
		return false, errCheckInput
	}
	return checker.validateDocument(document)
}

func (checker *checkedSchema) validateDocument(document any) (bool, error) {
	err := checker.schema.Validate(document)
	// A failed match can make `not` or an `if` branch succeed. Its sticky flag
	// therefore invalidates the entire evaluation, even when Validate returns nil.
	if checker.failed.Load() {
		return false, errCheckRegex
	}
	var rejected *jsonschema.ValidationError
	if err != nil && !errors.As(err, &rejected) {
		return false, errCheckSchema
	}
	return err == nil, nil
}

func decodeSchemaDocument(data []byte) (any, bool) {
	value, valid := decodeCheckDocument(data)
	if !valid {
		return nil, false
	}
	return mapCheckNumbers(value, schemaCheckNumber)
}

func schemaCheckNumber(number json.Number) (any, bool) {
	// Reject overflow/underflow before the schema library's exact arithmetic.
	// Canonical zero also avoids expansion of inputs such as 0e1000000.
	if _, err := number.Float64(); err != nil {
		return nil, false
	}
	value, valid := normalizeCheckNumber(number)
	if decimal, isDecimal := value.(checkDecimal); isDecimal {
		if decimal.coefficient == "" {
			return json.Number("0"), valid
		}
		return json.Number(decimal.coefficient + "e" + strconv.FormatInt(decimal.exponent, 10)), valid
	}
	return value, valid
}

func checkSchema(mode string, arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) < schemaCheckArguments || len(arguments) > schemaCheckArguments+1 ||
		(mode != schemaCheckMode && mode != eventBatchCheckMode) {
		return writeText(diagnostic, validationUsage, exitUsage)
	}
	expectInvalid := len(arguments) == schemaCheckArguments+1
	if expectInvalid && (mode != eventBatchCheckMode || arguments[len(arguments)-1] != expectInvalidOption) {
		return writeText(diagnostic, validationUsage, exitUsage)
	}
	schema, _ := readCheckFile(arguments[0])
	checker, err := compileCheckSchema(schema)
	if err != nil {
		return writeText(diagnostic, "schema check failed: "+err.Error()+"\n", exitFailure)
	}
	data, _ := readCheckFile(arguments[1])
	scope, validate := "json_schema", checker.validate
	if mode == eventBatchCheckMode {
		scope, validate = "event_batch", checker.validateEventBatch
	}
	valid, err := validate(data)
	if err != nil {
		return writeText(diagnostic, "schema check failed: "+err.Error()+"\n", exitFailure)
	}
	code := exitFailure
	if valid != expectInvalid {
		code = exitOK
	}
	result := `{"scope":"` + scope + `","valid":` + strconv.FormatBool(valid)
	if mode == eventBatchCheckMode {
		result += `,"expected_invalid":` + strconv.FormatBool(expectInvalid)
	}
	return writeText(output, result+"}\n", code)
}
