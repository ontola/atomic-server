# API

The API of AtomicServer uses _Atomic Data_.

All Atomic Data resources have a unique URL, which can be fetched using HTTP.
Every single Class, Property or Endpoint also is a resource, which means you can visit these in the browser!
This effectively makes most of the API **browsable** and **self-documenting**.

Every individual resource URL can be fetched using a GET request using your favorite HTML tool or library.
You can also simply open every resource in your browser!
If you want some specific representation (e.g. `JSON`), you will need to add an `Accept` header to your request.

```sh
# Fetch as JSON-AD (de facto standard for Atomic Data)
curl -i -H "Accept: application/ad+json" https://atomicdata.dev/properties/shortname
# Fetch as JSON-LD
curl -i -H "Accept: application/ld+json" https://atomicdata.dev/properties/shortname
# Fetch as JSON
curl -i -H "Accept: application/json" https://atomicdata.dev/properties/shortname
# Fetch as Turtle / N3
curl -i -H "Accept: text/turtle" https://atomicdata.dev/properties/shortname
```

## Endpoints

The various [Endpoints](../endpoints.md) in AtomicServer can be seen at `/endpoints` of your local instance.
These include functionality to create changes using `/commits`, query data using `/query`, get `/versions`, or do full-text search queries using `/search`.
Typically, you pass query parameters to these endpoints to specify what you want to do.

<!-- We have a subset of the [API documented using Swagger / OpenAPI](https://editor.swagger.io/?url=https://raw.githubusercontent.com/atomicdata-dev/atomic-server/master/server/openapi.yml). -->

## Python example

AtomicServer does not require a Python-specific SDK for reading public data. You can use any HTTP client; the examples below use [`requests`](https://requests.readthedocs.io/).

Install it with:

```sh
python -m pip install requests
```

### Fetch a resource as JSON-AD

Every Atomic Data resource is available at its subject URL. Set the `Accept` header to request JSON-AD explicitly:

```python
import requests

JSON_AD = "application/ad+json"
RESOURCE_URL = "https://atomicdata.dev/properties/shortname"

response = requests.get(
    RESOURCE_URL,
    headers={"Accept": JSON_AD},
    timeout=10,
)
response.raise_for_status()
resource = response.json()

print(resource["@id"])
print(resource["https://atomicdata.dev/properties/shortname"])
```

For a local server, replace the resource URL with one hosted by your instance, such as `http://localhost:9883/`.

### Search resources

The `/search` endpoint supports full-text search through the `q` parameter. `limit` controls the maximum number of results, while `include=true` includes the matched resources in the JSON-AD response instead of returning only their subjects.

```python
import requests

SERVER_URL = "https://atomicdata.dev"

response = requests.get(
    f"{SERVER_URL}/search",
    params={
        "q": "atomic data",
        "limit": 10,
        "include": "true",
    },
    headers={"Accept": "application/ad+json"},
    timeout=10,
)
response.raise_for_status()
search_results = response.json()

# Endpoint responses can contain multiple JSON-AD resources.
resources = search_results if isinstance(search_results, list) else [search_results]
for resource in resources:
    print(resource.get("@id"))
```

The endpoint also accepts `parents` (a comma-separated list of ancestor resource URLs) and `filters` (a Tantivy query expression) to narrow results.

### Query resources by property

Use `/query` to create a dynamic Collection. Query parameter names match the shortnames documented for [Atomic Collections](../schema/collections.md). For example, this query returns resources whose `isA` property points to the Property class:

```python
import requests

SERVER_URL = "https://atomicdata.dev"
IS_A = "https://atomicdata.dev/properties/isA"
PROPERTY_CLASS = "https://atomicdata.dev/classes/Property"

response = requests.get(
    f"{SERVER_URL}/query",
    params={
        "property": IS_A,
        "value": PROPERTY_CLASS,
        "page_size": 10,
        "current_page": 0,
    },
    headers={"Accept": "application/ad+json"},
    timeout=10,
)
response.raise_for_status()
collection = response.json()

print(collection)
```

Public resources can be read without authentication. Private resources require a signed authentication request. Creating or changing resources requires a signed [Atomic Commit](../commits/intro.md) containing a Loro CRDT update; use a supported [client or SDK](../tooling.md) rather than posting ordinary JSON directly.

## Libraries or API?

You can use the REST API if you want, but it's recommended to use one of our [libraries](../tooling.md).
