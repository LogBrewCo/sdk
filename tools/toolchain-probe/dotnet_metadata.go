package main

import (
	"os"
	"strconv"
	"strings"
)

const (
	dotnetMetadataInitialVersion = "0.1.0"
	dotnetMetadataStandard       = "netstandard2.0"
	dotnetMetadataFamily         = "dotnet"
	dotnetMetadataPrefix         = "dotnet/logbrew-dotnet/"
	dotnetMetadataSource         = dotnetMetadataPrefix + "src/"
	dotnetMetadataCore           = "LogBrew"
	dotnetMetadataHTTP           = "LogBrew.HttpClient"
	dotnetMetadataProject        = ".csproj"
	dotnetMetadataProperties     = "PropertyGroup"
	dotnetMetadataID             = "PackageId"
	dotnetMetadataVersion        = "Version"
	dotnetMetadataTarget         = "TargetFramework"
	dotnetMetadataTargets        = "TargetFrameworks"
	dotnetMetadataPackable       = "IsPackable"
	dotnetMetadataIcon           = "logbrew-logo-espresso-bg-128.png"
	dotnetMetadataCoreIcon       = "logbrew-logo-transparent-128.png"
	dotnetMetadataCoreReference  = `ProjectReference Include="../LogBrew/LogBrew.csproj"`
)

type dotnetMetadataPackage struct {
	id, version, target, example string
	dependencies                 []string
}

//nolint:revive // unsecure-url-scheme: MSBuild identifier, not fetched. Reviewed 2026-09-12.
const dotnetMetadataNamespace = "http://schemas.microsoft.com/developer/msbuild/2003"

type dotnetMetadataPolicy struct {
	fields map[string]string
	source sourceMetadataPolicy
}

func dotnetMetadataPackages() []dotnetMetadataPackage {
	return []dotnetMetadataPackage{
		{dotnetMetadataCore, "0.1.7", "netstandard2.0;net8.0", "", nil},
		{
			"LogBrew.AspNetCore", "0.1.2", "net10.0", "AspNetCoreMiddlewareTelemetry.cs",
			[]string{`FrameworkReference Include="Microsoft.AspNetCore.App"`},
		},
		{
			"LogBrew.EntityFrameworkCore", dotnetMetadataInitialVersion, "net10.0",
			"EntityFrameworkCoreCommandTelemetry.cs",
			[]string{`PackageReference Include="Microsoft.EntityFrameworkCore.Relational"`},
		},
		{
			"LogBrew.Hangfire", dotnetMetadataInitialVersion, dotnetMetadataStandard, "HangfireJobTelemetry.cs",
			[]string{`PackageReference Include="Hangfire.Core"`, `PackageReference Include="Newtonsoft.Json"`},
		},
		{
			dotnetMetadataHTTP, "0.1.2", "netstandard2.0;net8.0", "HttpClientFactoryCorrelation.cs",
			[]string{`PackageReference Include="Microsoft.Extensions.Http"`},
		},
		{
			"LogBrew.StackExchangeRedis", dotnetMetadataInitialVersion, dotnetMetadataStandard,
			"StackExchangeRedisCommandTelemetry.cs",
			[]string{`PackageReference Include="StackExchange.Redis"`},
		},
		{
			"LogBrew.OpenTelemetry", "0.1.1", dotnetMetadataStandard, "OpenTelemetrySpanProcessorTelemetry.cs",
			[]string{`PackageReference Include="OpenTelemetry"`},
		},
	}
}

func dotnetMetadataPolicies(versions map[string]string) map[string]dotnetMetadataPolicy {
	packages := dotnetMetadataPackages()
	known := make(map[string]bool, len(packages))
	for index, pkg := range packages {
		known[pkg.id] = true
		if version, present := versions[pkg.id]; present {
			if !validPythonPackageVersion(version) {
				return nil
			}
			packages[index].version = version
		}
	}
	for id := range versions {
		if !known[id] {
			return nil
		}
	}
	coreRange := dotnetCompatibleRange(packages[0].version)
	if coreRange == "" {
		return nil
	}
	policies := make(map[string]dotnetMetadataPolicy, len(packages))
	for _, pkg := range packages {
		policies[pkg.id] = pkg.policy(coreRange)
	}
	return policies
}

func dotnetMetadataOverrideCheck(arguments []string) func(*os.Root) bool {
	if len(arguments) > len(dotnetMetadataPackages()) {
		return nil
	}
	versions := make(map[string]string, len(arguments))
	for _, argument := range arguments {
		id, version, found := strings.Cut(argument, "=")
		if !found || versions[id] != "" || !validPythonPackageVersion(version) {
			return nil
		}
		versions[id] = version
	}
	policies := dotnetMetadataPolicies(versions)
	if policies == nil {
		return nil
	}
	return func(root *os.Root) bool { return checkDotnetMetadataPolicies(root, policies) }
}

func dotnetCompatibleRange(version string) string {
	const componentBits = 32
	if !validPythonPackageVersion(version) {
		return ""
	}
	parts := strings.Split(version, ".")
	major, majorError := strconv.ParseUint(parts[0], 10, componentBits)
	minor, minorError := strconv.ParseUint(parts[1], 10, componentBits)
	if majorError != nil || minorError != nil {
		return ""
	}
	upper := strconv.FormatUint(major+1, 10) + ".0.0"
	if major == 0 {
		upper = "0." + strconv.FormatUint(minor+1, 10) + ".0"
	}
	return "[" + version + ", " + upper + ")"
}

func (pkg *dotnetMetadataPackage) policy(coreRange string) dotnetMetadataPolicy {
	const repository = "https://github.com/LogBrewCo/sdk"
	fields := map[string]string{
		dotnetMetadataID: pkg.id, dotnetMetadataVersion: pkg.version,
		"Authors": dotnetMetadataCore, "Company": dotnetMetadataCore,
		"PackageLicenseExpression": releaseMetadataLicense, "PackageProjectUrl": repository,
		"RepositoryUrl": repository, "PackageReadmeFile": policyRootGuide, "PackageIcon": dotnetMetadataIcon,
		dotnetMetadataTarget: pkg.target,
	}
	if pkg.id == dotnetMetadataCore || pkg.id == dotnetMetadataHTTP {
		delete(fields, dotnetMetadataTarget)
		fields[dotnetMetadataTargets] = pkg.target
	}
	if pkg.id == dotnetMetadataCore {
		fields["PackageIcon"] = dotnetMetadataCoreIcon
	}
	if pkg.id == dotnetMetadataHTTP {
		fields["IsAotCompatible"], fields["SignAssembly"] = strconv.FormatBool(true), strconv.FormatBool(false)
		fields["LogBrewCoreDependencyVersion"] = coreRange
	}
	return dotnetMetadataPolicy{fields: fields, source: pkg.sourcePolicy()}
}

func (pkg *dotnetMetadataPackage) sourcePolicy() sourceMetadataPolicy {
	const coreFiles, corePhrases = 9, 8
	prefix := dotnetMetadataSource + pkg.id + "/"
	manifest := prefix + pkg.id + dotnetMetadataProject
	files := []string{prefix + policyRootGuide, "assets/brand/" + dotnetMetadataIcon}
	phrases := append([]string{dotnetMetadataCoreReference}, pkg.dependencies...)
	if pkg.id == dotnetMetadataCore {
		files = make([]string, 0, coreFiles)
		files = append(files, dotnetMetadataPrefix+policyRootGuide, "assets/brand/"+dotnetMetadataCoreIcon)
		phrases = make([]string, 0, corePhrases)
		phrases = append(phrases, `PackageVersion Condition="'$(LogBrewProjectReferenceVersion)' != ''"`)
		for _, example := range []string{
			"FirstUsefulTelemetry.cs", "ActivityTraceCorrelation.cs", "ActivitySourceListenerTelemetry.cs",
			"DependencySpansTelemetry.cs", "DbCommandTelemetry.cs", "HttpClientOutboundTelemetry.cs",
			"AspNetCoreRequestTelemetry.cs",
		} {
			files = append(files, dotnetMetadataPrefix+"examples/"+example)
			phrases = append(phrases, "examples/"+example)
		}
	} else {
		exampleRoot := dotnetMetadataPrefix
		if pkg.id == dotnetMetadataHTTP {
			exampleRoot = prefix
		}
		files = append(files, exampleRoot+"examples/"+pkg.example)
		phrases = append(phrases, "examples/"+pkg.example)
	}
	return sourceMetadataPolicy{prefix: "", files: files, text: map[string][]string{manifest: phrases}, patterns: nil}
}

func dotnetProjectProperties(data []byte) *metadataXMLNode {
	project := parseMetadataXML(data)
	if project == nil || project.name != "Project" {
		return nil
	}
	if (project.namespace != "" && project.namespace != dotnetMetadataNamespace) ||
		!project.hasNamespace(project.namespace) {
		return nil
	}
	for _, child := range project.children {
		if child.name == dotnetMetadataProperties {
			if !validDotnetPackability(child) {
				return nil
			}
			return child
		}
	}
	return nil
}

func validDotnetPackability(properties *metadataXMLNode) bool {
	for _, field := range properties.children {
		if field.name == dotnetMetadataPackable {
			value := properties.value(dotnetMetadataPackable)
			return strings.EqualFold(value, strconv.FormatBool(false)) ||
				strings.EqualFold(value, strconv.FormatBool(true))
		}
	}
	return true
}

func (policy dotnetMetadataPolicy) valid(data []byte) bool {
	properties := dotnetProjectProperties(data)
	if properties == nil || !strings.Contains(properties.value("Description"), dotnetMetadataCore) {
		return false
	}
	for name, expected := range policy.fields {
		if properties.value(name) != expected {
			return false
		}
	}
	return true
}

func checkDotnetMetadata(root *os.Root) bool {
	return checkDotnetMetadataPolicies(root, dotnetMetadataPolicies(nil))
}

func checkDotnetMetadataPolicies(root *os.Root, policies map[string]dotnetMetadataPolicy) bool {
	if len(policies) == 0 || !checkDotnetMetadataCatalog(root, policies) {
		return false
	}
	for _, policy := range policies {
		for manifest := range policy.source.text {
			data, read := readReleaseMetadata(root, manifest)
			if !read || !policy.valid(data) || !policy.source.check(root) {
				return false
			}
		}
	}
	return true
}
