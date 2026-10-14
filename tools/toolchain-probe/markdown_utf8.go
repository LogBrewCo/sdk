package main

import "unicode/utf8"

func markdownReplacementUTF8(data []byte) string {
	var decoded []rune
	for len(data) > 0 {
		value, size := utf8.DecodeRune(data)
		if value == utf8.RuneError && size == 1 {
			size = markdownInvalidPrefix(data)
		}
		decoded = append(decoded, value)
		data = data[size:]
	}
	return string(decoded)
}

func markdownInvalidPrefix(data []byte) int {
	const (
		minimumTwo        = 0xc2
		minimumThree      = 0xe0
		minimumFour       = 0xf0
		maximumFour       = 0xf4
		continuationStart = 0x80
		continuationEnd   = 0xbf
	)
	lead := data[0]
	var expected int
	switch {
	case lead >= minimumTwo && lead < minimumThree:
		expected = 2
	case lead >= minimumThree && lead < minimumFour:
		expected = 3
	case lead >= minimumFour && lead <= maximumFour:
		expected = 4
	default:
		return 1
	}
	for index := 1; index < expected; index++ {
		if index >= len(data) || data[index] < continuationStart || data[index] > continuationEnd {
			return index
		}
		if index == 1 && !markdownSecondByte(lead, data[index]) {
			return 1
		}
	}
	return 1
}

func markdownSecondByte(lead, second byte) bool {
	const (
		threeStart       = 0xe0
		surrogateStart   = 0xed
		fourStart        = 0xf0
		fourEnd          = 0xf4
		threeMinimum     = 0xa0
		surrogateMaximum = 0x9f
		fourMinimum      = 0x90
		fourMaximum      = 0x8f
	)
	return (lead != threeStart || second >= threeMinimum) &&
		(lead != surrogateStart || second <= surrogateMaximum) &&
		(lead != fourStart || second >= fourMinimum) &&
		(lead != fourEnd || second <= fourMaximum)
}
