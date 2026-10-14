package main

import "slices"

const (
	registryPythonFamily     = "pypi"
	registryLatestTag        = "latest"
	registryGoInit           = "init"
	registryNPMFamily        = "npm"
	registryPackagistFamily  = "packagist"
	registryCratesFamily     = "crates"
	registryRubyFamily       = "rubygems"
	registryOpenUPMFamily    = "openupm"
	registryPackagistPackage = "logbrew/sdk"
	registryAspNetPackage    = "LogBrew.AspNetCore"
	registryEFPackage        = "LogBrew.EntityFrameworkCore"
	registryHangfirePackage  = "LogBrew.Hangfire"
	registryOTelPackage      = "LogBrew.OpenTelemetry"
	registryRedisPackage     = "LogBrew.StackExchangeRedis"
	registryUnityPackage     = "co.logbrew.unity"
)

// Registry defaults preserve the released verifier's selection independently of
// the source metadata catalog, which also includes unpublished integrations.
func registryPackageCatalog(family string) []string {
	packages := make([]string, 0, len(jsMetadataPackages()))
	switch family {
	case registryNPMFamily:
		packages = make([]string, 0, len(jsMetadataPackages()))
		for _, name := range jsMetadataPackages() {
			if name != jsMetadataScope+"prisma" {
				packages = append(packages, name)
			}
		}
		slices.Sort(packages)
	case registryPythonFamily, registryRubyFamily:
		packages = []string{pythonCoreID}
	case nugetJobName:
		packages = make([]string, 0, len(dotnetMetadataPackages()))
		for _, pkg := range dotnetMetadataPackages() {
			packages = append(packages, pkg.id)
		}
	case registryPackagistFamily:
		packages = []string{registryPackagistPackage}
	case registryCratesFamily:
		packages = []string{releaseMetadataKeyword}
	case mavenMetadataFamily:
		packages = make([]string, 0, len(mavenMetadataPackages()))
		for _, pkg := range mavenMetadataPackages() {
			packages = append(packages, pkg.artifact)
		}
	case registryOpenUPMFamily:
		packages = []string{registryUnityPackage}
	default:
	}
	if len(packages) == 0 {
		return nil
	}
	return packages
}
