package co.logbrew.sdk;

import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

/** Observes body terminal signals without replacing the app's response or body. */
final class LogBrewHttpBodyTracing {
    @FunctionalInterface
    interface CompletionHandler {
        void finish(HttpResponse<?> response, int statusCode, Throwable error, boolean cancelled);
    }

    private final CompletionHandler handler;
    private boolean bodyStarted;
    private boolean bodyFinished;
    private boolean responseFinished;
    private boolean captured;
    private boolean cancelling;
    private int statusCode;
    private HttpResponse<?> response;
    private Throwable error;

    LogBrewHttpBodyTracing(CompletionHandler handler) {
        this.handler = handler;
    }

    <T> HttpResponse.BodyHandler<T> observe(HttpResponse.BodyHandler<T> downstream) {
        return info -> {
            synchronized (this) {
                bodyStarted = true;
                statusCode = info.statusCode();
            }
            return new Subscriber<>(downstream.apply(info));
        };
    }

    void responseComplete(HttpResponse<?> value, Throwable failure) {
        Completion completion;
        synchronized (this) {
            response = value;
            responseFinished = true;
            if (failure != null) {
                error = cancelling ? new CancellationException() : failure;
            }
            completion = completion();
        }
        capture(completion);
    }

    private void bodyComplete(Throwable failure) {
        Completion completion;
        synchronized (this) {
            bodyFinished = true;
            if (failure != null) {
                error = cancelling ? new CancellationException() : failure;
            }
            completion = completion();
        }
        capture(completion);
    }

    private Completion completion() {
        if (captured || !responseFinished || bodyStarted && !bodyFinished && error == null) {
            return null;
        }
        captured = true;
        return new Completion(response, statusCode, error, cancelling);
    }

    private void capture(Completion completion) {
        if (completion != null) {
            handler.finish(completion.response, completion.statusCode, completion.error, completion.cancelled);
        }
    }

    private static final class Completion {
        private final HttpResponse<?> response;
        private final int statusCode;
        private final Throwable error;
        private final boolean cancelled;

        private Completion(HttpResponse<?> response, int statusCode, Throwable error, boolean cancelled) {
            this.response = response;
            this.statusCode = statusCode;
            this.error = error;
            this.cancelled = cancelled;
        }
    }

    private final class Subscriber<T> implements HttpResponse.BodySubscriber<T> {
        private final HttpResponse.BodySubscriber<T> downstream;

        private Subscriber(HttpResponse.BodySubscriber<T> downstream) {
            this.downstream = downstream;
        }

        @Override
        public CompletionStage<T> getBody() {
            return downstream.getBody();
        }

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            try {
                downstream.onSubscribe(new Flow.Subscription() {
                    @Override
                    public void request(long count) {
                        subscription.request(count);
                    }

                    @Override
                    public void cancel() {
                        synchronized (LogBrewHttpBodyTracing.this) {
                            cancelling = true;
                        }
                        try {
                            subscription.cancel();
                        } finally {
                            bodyComplete(new CancellationException());
                        }
                    }
                });
            } catch (RuntimeException | Error failure) {
                bodyComplete(failure);
                throw failure;
            }
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            try {
                downstream.onNext(buffers);
            } catch (RuntimeException | Error failure) {
                bodyComplete(failure);
                throw failure;
            }
        }

        @Override
        public void onError(Throwable failure) {
            try {
                bodyComplete(failure);
            } finally {
                downstream.onError(failure);
            }
        }

        @Override
        public void onComplete() {
            try {
                bodyComplete(null);
            } finally {
                downstream.onComplete();
            }
        }
    }
}
