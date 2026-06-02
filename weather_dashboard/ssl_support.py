from __future__ import annotations

import os
import warnings

_SSL_CONFIGURED = False


def configure_ssl_defaults() -> None:
    """Configure process-wide TLS defaults.

    Order of preference:
    1. Use the OS certificate store via truststore when available.
    2. Honor explicit REQUESTS_CA_BUNDLE / SSL_CERT_FILE if the user set them.
    3. If DASHBOARD_SSL_VERIFY=false, suppress insecure warnings because the
       caller intentionally disabled verification.
    """

    global _SSL_CONFIGURED
    if _SSL_CONFIGURED:
        return

    use_system_store = os.getenv("DASHBOARD_USE_SYSTEM_CERT_STORE", "true").strip().lower()
    if use_system_store not in {"0", "false", "no", "off"}:
        try:
            import truststore

            truststore.inject_into_ssl()
        except Exception:
            # Continue with default certifi behavior if truststore is unavailable.
            pass

    ssl_verify = os.getenv("DASHBOARD_SSL_VERIFY", "true").strip().lower()
    if ssl_verify in {"0", "false", "no", "off"}:
        try:
            from urllib3.exceptions import InsecureRequestWarning
        except Exception:
            InsecureRequestWarning = None
        if InsecureRequestWarning is not None:
            warnings.simplefilter("ignore", InsecureRequestWarning)

    _SSL_CONFIGURED = True
