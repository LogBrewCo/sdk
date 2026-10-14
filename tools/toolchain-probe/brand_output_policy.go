package main

func brandOutputPolicy(outputs map[string][]byte) bool {
	generated := brandGeneratedAssets()
	if len(outputs) != len(generated) {
		return false
	}
	remaining := markdownByteLimit
	for name, data := range outputs {
		generation, known := generated[name]
		if !known || len(data) == 0 || len(data) > brandSVGByteLimit || len(data) > remaining {
			return false
		}
		remaining -= len(data)
		switch generation {
		case brandSVGDerivative:
			if root, _ := brandSVGParse(data); root == nil {
				return false
			}
		case brandRasterGeneration:
			if _, valid := brandPNGNormalizedPixels(data); !valid {
				return false
			}
		default:
			return false
		}
	}
	return true
}
