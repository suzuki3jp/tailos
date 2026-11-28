/** Works with both browser errors and plain errors hydrated from the server. */
export function requestErrorStatus(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  )
    return error.status;
}

/** Browser API failures expose an optional string code in their JSON body. */
export async function responseErrorCode(response: Pick<Response, "json">) {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  )
    return body.error;
}
