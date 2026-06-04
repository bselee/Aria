/** @file RootRoute — meta-refresh redirect to /dashboard
 *  @purpose Redirects root URL to /dashboard using HTML meta refresh.
 *  @author Hermia
 *  @created 2026-06-02
 */

export default function RootPage() {
  return (
    <>
      <head>
        <meta httpEquiv="refresh" content="0;url=/dashboard" />
      </head>
      <p style={{ color: "#666", fontFamily: "monospace", textAlign: "center", marginTop: "40vh" }}>
        ↻ redirecting to Aria dashboard...
      </p>
    </>
  );
}