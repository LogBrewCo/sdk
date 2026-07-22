package logbrew

import (
	"bufio"
	"io"
	"net"
	"net/http"
)

type statusRecordingResponseWriter struct {
	responseWriter http.ResponseWriter
	status         int
}

func newStatusRecordingResponseWriter(w http.ResponseWriter) *statusRecordingResponseWriter {
	return &statusRecordingResponseWriter{responseWriter: w}
}

func (w *statusRecordingResponseWriter) Header() http.Header {
	return w.responseWriter.Header()
}

func (w *statusRecordingResponseWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func (w *statusRecordingResponseWriter) StatusForPanic() int {
	if w.status == 0 {
		return http.StatusInternalServerError
	}
	return w.status
}

func (w *statusRecordingResponseWriter) WriteHeader(status int) {
	if w.status == 0 && !isInformationalHTTPStatus(status) {
		w.status = status
	}
	w.responseWriter.WriteHeader(status)
}

func (w *statusRecordingResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.responseWriter.Write(data)
}

func (w *statusRecordingResponseWriter) Unwrap() http.ResponseWriter {
	return w.responseWriter
}

func isInformationalHTTPStatus(status int) bool {
	return status >= 100 && status <= 199 && status != http.StatusSwitchingProtocols
}

type responseWriterCore interface {
	http.ResponseWriter
	Unwrap() http.ResponseWriter
}

type responseWriterFlushController interface {
	http.Flusher
	FlushError() error
}

type responseWriterFlusher struct {
	recorder *statusRecordingResponseWriter
	flusher  http.Flusher
}

func (w responseWriterFlusher) Flush() {
	_ = w.FlushError()
}

func (w responseWriterFlusher) FlushError() error {
	if w.recorder.status == 0 {
		w.recorder.status = http.StatusOK
	}
	if flusher, ok := w.flusher.(interface{ FlushError() error }); ok {
		return flusher.FlushError()
	}
	w.flusher.Flush()
	return nil
}

type responseWriterHijacker struct {
	hijacker http.Hijacker
}

func (w responseWriterHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.hijacker.Hijack()
}

type responseWriterPusher struct {
	pusher http.Pusher
}

func (w responseWriterPusher) Push(target string, options *http.PushOptions) error {
	return w.pusher.Push(target, options)
}

type responseWriterReaderFrom struct {
	recorder   *statusRecordingResponseWriter
	readerFrom io.ReaderFrom
}

func (w responseWriterReaderFrom) ReadFrom(reader io.Reader) (int64, error) {
	if w.recorder.status == 0 {
		w.recorder.status = http.StatusOK
	}
	return w.readerFrom.ReadFrom(reader)
}

func wrapStatusRecordingResponseWriter(
	underlying http.ResponseWriter,
	recorder *statusRecordingResponseWriter,
) http.ResponseWriter {
	core := responseWriterCore(recorder)
	flusher, hasFlusher := underlying.(http.Flusher)
	hijacker, hasHijacker := underlying.(http.Hijacker)
	pusher, hasPusher := underlying.(http.Pusher)
	readerFrom, hasReaderFrom := underlying.(io.ReaderFrom)

	var flush responseWriterFlushController
	if hasFlusher {
		flush = responseWriterFlusher{recorder: recorder, flusher: flusher}
	}
	var hijack http.Hijacker
	if hasHijacker {
		hijack = responseWriterHijacker{hijacker: hijacker}
	}
	var push http.Pusher
	if hasPusher {
		push = responseWriterPusher{pusher: pusher}
	}
	var readFrom io.ReaderFrom
	if hasReaderFrom {
		readFrom = responseWriterReaderFrom{recorder: recorder, readerFrom: readerFrom}
	}

	mask := 0
	if hasFlusher {
		mask |= 1
	}
	if hasHijacker {
		mask |= 2
	}
	if hasPusher {
		mask |= 4
	}
	if hasReaderFrom {
		mask |= 8
	}

	switch mask {
	case 1:
		return struct {
			responseWriterCore
			responseWriterFlushController
		}{core, flush}
	case 2:
		return struct {
			responseWriterCore
			http.Hijacker
		}{core, hijack}
	case 3:
		return struct {
			responseWriterCore
			responseWriterFlushController
			http.Hijacker
		}{core, flush, hijack}
	case 4:
		return struct {
			responseWriterCore
			http.Pusher
		}{core, push}
	case 5:
		return struct {
			responseWriterCore
			responseWriterFlushController
			http.Pusher
		}{core, flush, push}
	case 6:
		return struct {
			responseWriterCore
			http.Hijacker
			http.Pusher
		}{core, hijack, push}
	case 7:
		return struct {
			responseWriterCore
			responseWriterFlushController
			http.Hijacker
			http.Pusher
		}{core, flush, hijack, push}
	case 8:
		return struct {
			responseWriterCore
			io.ReaderFrom
		}{core, readFrom}
	case 9:
		return struct {
			responseWriterCore
			responseWriterFlushController
			io.ReaderFrom
		}{core, flush, readFrom}
	case 10:
		return struct {
			responseWriterCore
			http.Hijacker
			io.ReaderFrom
		}{core, hijack, readFrom}
	case 11:
		return struct {
			responseWriterCore
			responseWriterFlushController
			http.Hijacker
			io.ReaderFrom
		}{core, flush, hijack, readFrom}
	case 12:
		return struct {
			responseWriterCore
			http.Pusher
			io.ReaderFrom
		}{core, push, readFrom}
	case 13:
		return struct {
			responseWriterCore
			responseWriterFlushController
			http.Pusher
			io.ReaderFrom
		}{core, flush, push, readFrom}
	case 14:
		return struct {
			responseWriterCore
			http.Hijacker
			http.Pusher
			io.ReaderFrom
		}{core, hijack, push, readFrom}
	case 15:
		return struct {
			responseWriterCore
			responseWriterFlushController
			http.Hijacker
			http.Pusher
			io.ReaderFrom
		}{core, flush, hijack, push, readFrom}
	default:
		return core
	}
}
