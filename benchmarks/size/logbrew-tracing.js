import {
  installLogBrewBrowser,
  installLogBrewBrowserFetchInstrumentation,
  installLogBrewBrowserInteractionTimingInstrumentation,
  installLogBrewBrowserNavigationInstrumentation,
  installLogBrewBrowserNavigationTimingInstrumentation,
  installLogBrewBrowserResourceTimingInstrumentation,
  installLogBrewBrowserWebVitalsInstrumentation,
  installLogBrewBrowserXhrInstrumentation
} from "@logbrew/browser";
import * as webVitals from "web-vitals";

const logbrew = installLogBrewBrowser({ clientKey: "LOGBREW_BROWSER_KEY" });
const tracePropagationTargets = [/^\/api\//];

installLogBrewBrowserNavigationInstrumentation(logbrew);
installLogBrewBrowserFetchInstrumentation(logbrew, { tracePropagationTargets });
installLogBrewBrowserXhrInstrumentation(logbrew, { tracePropagationTargets });
installLogBrewBrowserNavigationTimingInstrumentation(logbrew);
installLogBrewBrowserResourceTimingInstrumentation(logbrew);
installLogBrewBrowserInteractionTimingInstrumentation(logbrew);
installLogBrewBrowserWebVitalsInstrumentation(logbrew, {
  metricNames: ["LCP", "CLS", "INP", "FCP", "TTFB"],
  webVitals
});
