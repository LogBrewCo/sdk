package co.logbrew.sdk;

import java.util.Objects;

/** Immutable client-level delivery and shared-context options. */
public final class LogBrewClientOptions {
    private final DeliveryOptions deliveryOptions;
    private final TelemetryContext context;
    private final boolean disableRuntimeContext;

    private LogBrewClientOptions(Builder builder) {
        this.deliveryOptions = builder.deliveryOptions;
        this.context = builder.context;
        this.disableRuntimeContext = builder.disableRuntimeContext;
    }

    /** Returns a builder initialized with production delivery defaults. */
    public static Builder builder() {
        return new Builder();
    }

    DeliveryOptions deliveryOptions() {
        return deliveryOptions;
    }

    TelemetryContext context() {
        return context;
    }

    boolean disableRuntimeContext() {
        return disableRuntimeContext;
    }

    /** Builder for explicit client options. */
    public static final class Builder {
        private DeliveryOptions deliveryOptions = DeliveryOptions.builder().build();
        private TelemetryContext context;
        private boolean disableRuntimeContext;

        private Builder() {
        }

        /** Sets delivery bounds and persistence options. */
        public Builder deliveryOptions(DeliveryOptions value) {
            this.deliveryOptions = Objects.requireNonNull(value, "value");
            return this;
        }

        /** Sets shared context merged into every event. */
        public Builder context(TelemetryContext value) {
            this.context = Objects.requireNonNull(value, "value");
            return this;
        }

        /** Enables or disables Java runtime, OS family, and architecture defaults. */
        public Builder disableRuntimeContext(boolean value) {
            this.disableRuntimeContext = value;
            return this;
        }

        /** Builds immutable client options. */
        public LogBrewClientOptions build() {
            return new LogBrewClientOptions(this);
        }
    }
}
