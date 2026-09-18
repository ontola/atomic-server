/** Synthetic Clockify fixtures. No real account data or provider writes. */

/** The proxy's Clockify catalog document, as JSON: a read-only subset of the
 * public API with apiKey auth and page-number pagination. */
export const clockifyDocument =
  {
    "components": {
      "crudResources": {
        "timeEntry": {
          "collections": {
            "timeEntries": {
              "urlTemplate": "/v1/workspaces/{workspaceId}/user/{userId}/time-entries"
            }
          },
          "description": "A time entry on a Clockify workspace.",
          "identity": {
            "bindings": {
              "id": {
                "field": "id"
              }
            },
            "urlTemplate": "/v1/workspaces/{workspaceId}/time-entries/{id}"
          },
          "schema": {
            "$ref": "#/components/schemas/TimeEntry"
          }
        }
      },
      "paginationSchemes": {
        "pageNumber": {
          "description": "Clockify's list endpoints use 1-indexed page/page-size query parameters and return a plain JSON array with no pagination metadata in the body. Clockify also reports completion via a custom Last-Page response header, but paging stops the same way as other pageNumber platforms in this catalog: a page shorter than the requested page-size is the last one.",
          "request": {
            "queryParameters": {
              "page": {
                "role": "page"
              },
              "page-size": {
                "role": "pageSize"
              }
            }
          },
          "type": "pageNumber"
        }
      },
      "parameters": {
        "End": {
          "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format.",
          "in": "query",
          "name": "end",
          "required": false,
          "schema": {
            "format": "date-time",
            "type": "string"
          }
        },
        "Page": {
          "description": "Page number.",
          "in": "query",
          "name": "page",
          "required": false,
          "schema": {
            "default": 1,
            "minimum": 1,
            "type": "integer"
          }
        },
        "PageSize": {
          "description": "Page size.",
          "in": "query",
          "name": "page-size",
          "required": false,
          "schema": {
            "default": 50,
            "minimum": 1,
            "type": "integer"
          }
        },
        "Start": {
          "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format.",
          "in": "query",
          "name": "start",
          "required": false,
          "schema": {
            "format": "date-time",
            "type": "string"
          }
        },
        "UserId": {
          "description": "Represents a user identifier across the system.",
          "in": "path",
          "name": "userId",
          "required": true,
          "schema": {
            "type": "string"
          }
        },
        "WorkspaceId": {
          "description": "Represents a workspace identifier across the system.",
          "in": "path",
          "name": "workspaceId",
          "required": true,
          "schema": {
            "type": "string"
          }
        }
      },
      "schemas": {
        "TimeEntry": {
          "properties": {
            "billable": {
              "type": "boolean"
            },
            "description": {
              "nullable": true,
              "type": "string"
            },
            "id": {
              "type": "string"
            },
            "isLocked": {
              "type": "boolean"
            },
            "kioskId": {
              "nullable": true,
              "type": "string"
            },
            "projectId": {
              "nullable": true,
              "type": "string"
            },
            "tagIds": {
              "items": {
                "type": "string"
              },
              "nullable": true,
              "type": "array"
            },
            "taskId": {
              "nullable": true,
              "type": "string"
            },
            "timeInterval": {
              "$ref": "#/components/schemas/TimeInterval"
            },
            "type": {
              "enum": [
                "REGULAR",
                "BREAK"
              ],
              "type": "string"
            },
            "userId": {
              "type": "string"
            },
            "workspaceId": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "workspaceId",
            "userId"
          ],
          "type": "object"
        },
        "TimeInterval": {
          "nullable": true,
          "properties": {
            "duration": {
              "nullable": true,
              "type": "string"
            },
            "end": {
              "format": "date-time",
              "nullable": true,
              "type": "string"
            },
            "start": {
              "format": "date-time",
              "nullable": true,
              "type": "string"
            }
          },
          "type": "object"
        }
      },
      "securitySchemes": {
        "clockifyApiKey": {
          "description": "A personal API key generated in Clockify's Profile Settings. Clockify has no OAuth2 login; this is the only supported authentication mode.",
          "in": "header",
          "name": "X-Api-Key",
          "type": "apiKey"
        }
      }
    },
    "info": {
      "title": "Synthetic Clockify",
      "version": "v1",
      "description": "Test-only subset of the Clockify catalog document. No real account data."
    },
    "openapi": "3.0.3",
    "paths": {
      "/v1/workspaces/{workspaceId}/time-entries/{id}": {
        "get": {
          "operationId": "get-time-entry",
          "parameters": [
            {
              "$ref": "#/components/parameters/WorkspaceId"
            },
            {
              "description": "Represents a time entry identifier across the system.",
              "in": "path",
              "name": "id",
              "required": true,
              "schema": {
                "type": "string"
              }
            }
          ],
          "responses": {
            "200": {
              "content": {
                "application/json": {
                  "schema": {
                    "$ref": "#/components/schemas/TimeEntry"
                  }
                }
              },
              "description": "A single time entry."
            },
            "401": {
              "description": "The API key is missing or invalid."
            },
            "403": {
              "description": "The request is not allowed."
            },
            "404": {
              "description": "The time entry does not exist."
            }
          },
          "security": [
            {
              "clockifyApiKey": []
            }
          ],
          "summary": "Get a specific time entry on a workspace",
          "x-crud": {
            "action": "read",
            "resource": "timeEntry"
          }
        }
      },
      "/v1/workspaces/{workspaceId}/user/{userId}/time-entries": {
        "get": {
          "operationId": "get-time-entries-for-user",
          "parameters": [
            {
              "$ref": "#/components/parameters/WorkspaceId"
            },
            {
              "$ref": "#/components/parameters/UserId"
            },
            {
              "$ref": "#/components/parameters/Start"
            },
            {
              "$ref": "#/components/parameters/End"
            },
            {
              "$ref": "#/components/parameters/Page"
            },
            {
              "$ref": "#/components/parameters/PageSize"
            }
          ],
          "responses": {
            "200": {
              "content": {
                "application/json": {
                  "schema": {
                    "items": {
                      "$ref": "#/components/schemas/TimeEntry"
                    },
                    "type": "array"
                  }
                }
              },
              "description": "A page of the user's time entries on this workspace."
            },
            "401": {
              "description": "The API key is missing or invalid."
            },
            "403": {
              "description": "The request is not allowed."
            }
          },
          "security": [
            {
              "clockifyApiKey": []
            }
          ],
          "summary": "Get time entries for a user on a workspace",
          "x-crud": {
            "action": "list",
            "collection": "timeEntries",
            "resource": "timeEntry"
          },
          "x-pagination": [
            {
              "scheme": "pageNumber"
            }
          ]
        }
      }
    },
    "security": [
      {
        "clockifyApiKey": []
      }
    ],
    "servers": [
      {
        "url": "https://api.clockify.me/api"
      }
    ]
  };
export const WORKSPACE = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Test workspace' };
export const USER = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Test Person' };
const hour = 3_600_000;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Entries relative to `now`, so a 7-day window always finds some: two
 * completed entries yesterday, one older completed entry, a running timer
 * and a break (both skipped by the lens). */
export function clockifyEntries(now = Date.now()) {
  const day = 24 * hour;
  const entry = (id, description, start, end, extra = {}) => ({
    id,
    description,
    userId: USER.id,
    workspaceId: WORKSPACE.id,
    billable: true,
    projectId: 'cccccccccccccccccccccccc',
    taskId: null,
    tagIds: null,
    kioskId: null,
    isLocked: false,
    type: 'REGULAR',
    timeInterval: {
      start: iso(start),
      end: end === null ? null : iso(end),
      duration: end === null ? null : 'PT1H',
    },
    ...extra,
  });
  return [
    entry('entry-1', 'Fix plugin source loading', now - day - 4 * hour, now - day - 2 * hour),
    entry('entry-2', 'Weekly sync', now - day - hour, now - day, { billable: false }),
    entry('entry-3', 'Plugin catalog evidence', now - 20 * day, now - 20 * day + 3 * hour),
    entry('entry-4', 'Still running', now - hour, null),
    entry('entry-5', 'Lunch', now - day + hour, now - day + 2 * hour, { type: 'BREAK' }),
  ];
}

export function clockifyFixture() {
  const state = { entries: clockifyEntries(), requests: [] };
  return {
    state,
    request(method, url) {
      state.requests.push(`${method} ${url.pathname}${url.search}`);
      if (method !== 'GET') return { status: 403, body: {} };
      if (url.pathname === '/proxy/clockify/api/v1/user')
        return { status: 200, body: { ...USER, activeWorkspace: WORKSPACE.id } };
      if (url.pathname === '/proxy/clockify/api/v1/workspaces')
        return { status: 200, body: [WORKSPACE, { id: 'dddddddddddddddddddddddd', name: 'Personal' }] };
      const list = url.pathname.match(
        /^\/proxy\/clockify\/api\/v1\/workspaces\/([^/]+)\/user\/([^/]+)\/time-entries$/,
      );
      if (!list) return { status: 404, body: { message: 'Not found' } };
      if (list[1] !== WORKSPACE.id || list[2] !== USER.id)
        return { status: 403, body: { message: 'Forbidden' } };
      const start = Date.parse(url.searchParams.get('start') ?? '') || -Infinity;
      const end = Date.parse(url.searchParams.get('end') ?? '') || Infinity;
      const size = Number(url.searchParams.get('page-size') ?? 50);
      const page = Number(url.searchParams.get('page') ?? 1);
      const matching = state.entries.filter(e => {
        const at = Date.parse(e.timeInterval.start);
        return at >= start && at <= end;
      });
      return { status: 200, body: matching.slice((page - 1) * size, page * size) };
    },
  };
}
