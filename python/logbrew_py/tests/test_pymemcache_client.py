from __future__ import annotations

import json
import unittest

import cache_instrumentation_contract as contract
from logbrew_sdk import instrument_pymemcache_client_with_logbrew_spans


class PymemcacheInstrumentationTests(contract.CacheInstrumentationContract):
    django = True
    system = "memcached"
    framework = "pymemcache"
    attr = "_logbrew_pymemcache_instrumentation"
    instrument = staticmethod(instrument_pymemcache_client_with_logbrew_spans)

    def test_positional_get_and_gets_defaults_are_misses(self) -> None:
        class MissingPymemcacheClient:
            def get(self, key: bytes, default: bytes | None = None) -> bytes | None:
                return default

            def gets(
                self,
                key: bytes,
                default: bytes | None = None,
                cas_default: bytes | None = None,
            ) -> tuple[bytes | None, bytes | None]:
                return (default, cas_default)

        client = contract.sample_client()
        cache = MissingPymemcacheClient()
        instrument_pymemcache_client_with_logbrew_spans(
            cache,
            client=client,
            event_id_factory=iter(("evt_cache_get", "evt_cache_gets")).__next__,
            span_id_factory=iter(("b7ad6b7169203405", "b7ad6b7169203406")).__next__,
            clock=iter((715.0, 715.002, 716.0, 716.003)).__next__,
        )
        self.assertEqual(cache.get(b"private:key", b"fallback"), b"fallback")
        self.assertEqual(
            cache.gets(b"private:key", b"fallback", b"fallback-cas"),
            (b"fallback", b"fallback-cas"),
        )
        metadata = [
            event["attributes"]["metadata"]
            for event in json.loads(client.preview_json())["events"]
        ]
        self.assertEqual([item["cacheHit"] for item in metadata], [False, False])
        self.assertEqual(metadata[1]["cacheOperation"], "GETS")
        self.assertNotIn("itemSizeBytes", metadata[0])
        self.assertNotIn("itemSizeBytes", metadata[1])
        self.assertNotIn("fallback", client.preview_json())


if __name__ == "__main__":
    unittest.main()
