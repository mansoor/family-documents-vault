# API changelog

The API lives under `/api/v1`. It is a hard contract: one official app must work
against self-hosted servers that are months or years behind.

**The rules**

1. Changes are additive by default. New fields, endpoints and enum values ship
   without a version bump; clients ignore what they do not recognise.
2. Nothing is removed without a deprecation window of **four minor server
   releases**, announced here and surfaced in the `deprecations` list of
   `GET /api/v1/capabilities`.
3. New enum values are additive. Treat an unrecognised `status` or `visibility`
   as an opaque string.
4. The client declares its minimum server version; the server declares its
   minimum client version. Either side refusing says so in plain words.

## Unreleased

- `GET /api/v1/capabilities` — the capability document. Fetch it first,
  unauthenticated. Shape:

  ```json
  {
    "product": "family-document-vault",
    "server_version": "0.0.1",
    "api_version": 1,
    "min_client_version": "0.0.1",
    "edition": "self_hosted",
    "protection_mode": "standard",
    "features": { "...": false },
    "limits": { "max_upload_bytes": 104857600, "max_members": null, "max_storage_bytes": null },
    "deprecations": [],
    "branding": { "display_name": "Our family vault" }
  }
  ```

  `null` in `limits` means unlimited. Every `features` flag starts `false` and
  is switched on by the release that ships it.

## Deprecations in effect

None.
