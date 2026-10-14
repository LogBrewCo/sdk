package main

import "strconv"

const (
	registryIndexPairWidth  = 2
	registryIndexShortWidth = 3
	registryIndexSeparator  = "/"
)

func registryCratesIndexPath(name string) string {
	characters := []rune(name)
	switch len(characters) {
	case 0:
		return registryIndexSeparator + registryIndexSeparator
	case 1, registryIndexPairWidth:
		return strconv.Itoa(len(characters)) + registryIndexSeparator + name
	case registryIndexShortWidth:
		return "3/" + string(characters[:1]) + registryIndexSeparator + name
	default:
		return string(characters[:registryIndexPairWidth]) + registryIndexSeparator +
			string(characters[registryIndexPairWidth:registryIndexPairWidth*2]) + registryIndexSeparator + name
	}
}
