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
