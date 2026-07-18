package co.logbrew.sdk;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

/** Package-private scheduler ownership for automatic delivery. */
final class AutomaticDeliveryScheduler {
    interface Factory {
        Scheduler create();
    }

    interface Scheduler {
        ScheduledTask schedule(Runnable task, long delayMillis);

        void shutdown();

        void shutdownNow();

        boolean awaitTermination(long timeoutMillis) throws InterruptedException;
    }

    interface ScheduledTask {
        void cancel();

        boolean isDone();
    }

    interface Jitter {
        long select(long minimumInclusive, long maximumInclusive);
    }

    private AutomaticDeliveryScheduler() {
    }

    static Scheduler createDefault() {
        return new DefaultScheduler();
    }

    static long selectJitter(long minimumInclusive, long maximumInclusive) {
        return ThreadLocalRandom.current().nextLong(minimumInclusive, maximumInclusive + 1L);
    }

    private static final class DefaultScheduler implements Scheduler {
        private final ScheduledExecutorService executor;

        private DefaultScheduler() {
            ThreadFactory factory = task -> {
                Thread thread = new Thread(task, "logbrew-delivery");
                thread.setDaemon(true);
                return thread;
            };
            ScheduledThreadPoolExecutor scheduled = new ScheduledThreadPoolExecutor(1, factory);
            scheduled.setRemoveOnCancelPolicy(true);
            scheduled.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
            this.executor = scheduled;
        }

        @Override
        public ScheduledTask schedule(Runnable task, long delayMillis) {
            ScheduledFuture<?> future = executor.schedule(task, delayMillis, TimeUnit.MILLISECONDS);
            return new FutureTask(future);
        }

        @Override
        public void shutdown() {
            executor.shutdown();
        }

        @Override
        public void shutdownNow() {
            executor.shutdownNow();
        }

        @Override
        public boolean awaitTermination(long timeoutMillis) throws InterruptedException {
            return executor.awaitTermination(timeoutMillis, TimeUnit.MILLISECONDS);
        }
    }

    private static final class FutureTask implements ScheduledTask {
        private final ScheduledFuture<?> future;

        private FutureTask(ScheduledFuture<?> future) {
            this.future = future;
        }

        @Override
        public void cancel() {
            future.cancel(false);
        }

        @Override
        public boolean isDone() {
            return future.isDone();
        }
    }
}
