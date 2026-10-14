package main

func registryMavenVersions(payload any) map[string]bool {
	versions := make(map[string]bool)
	text, valid := payload.(string)
	if !valid {
		return versions
	}
	root := parseMetadataXML([]byte(text))
	if root == nil || !root.hasNamespace("") {
		return versions
	}
	versioning := root.path("versioning")
	if versioning == nil {
		return versions
	}
	for _, name := range []string{registryLatestTag, "release"} {
		if node := versioning.path(name); node != nil && len(node.text) != 0 {
			versions[string(node.text)] = true
		}
	}
	if entries := versioning.path(registryVersionsField); entries != nil {
		for _, node := range entries.children {
			if node.name == pythonManifestVersion && len(node.text) != 0 {
				versions[string(node.text)] = true
			}
		}
	}
	return versions
}
