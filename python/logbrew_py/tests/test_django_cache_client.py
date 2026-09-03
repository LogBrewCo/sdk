from __future__ import annotations

import cache_instrumentation_contract as contract
from logbrew_sdk import instrument_django_cache_with_logbrew_spans


class DjangoCacheInstrumentationTests(contract.CacheInstrumentationContract):
    django = True
    system = "django-cache"
    framework = "django-cache"
    attr = "_logbrew_django_cache_instrumentation"
    instrument = staticmethod(instrument_django_cache_with_logbrew_spans)
