// Where the frontend finds the backend (the API).
//
// Frontend run separately, e.g. VS Code Live Server on port 5500:
//   point this at the API server, and list the frontend's address in
//   CORS_ORIGINS in backend/server/.env so the API accepts its requests.
//
// Frontend served by the API itself (open http://localhost:3000):
//   this also works as it is, or set it to "" for "the same server".
window.DLIS_API = "http://localhost:3000";
