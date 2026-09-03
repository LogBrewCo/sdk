from __future__ import annotations

import cache_instrumentation_contract as contract
from logbrew_sdk import instrument_flask_cache_with_logbrew_spans


class FlaskCacheInstrumentationTests(contract.CacheInstrumentationContract):
    django = False
    system = "flask-caching"
    framework = "flask-caching"
    attr = "_logbrew_flask_cache_instrumentation"
    instrument = staticmethod(instrument_flask_cache_with_logbrew_spans)
