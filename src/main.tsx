import { render } from "preact";
import "./style.css";

function App() {
  return <main class="shell">
    <header><div class="mark">H</div><div><strong>HostPilot</strong><small>Python & Node.js cloud hosting</small></div></header>
    <section class="hero">
      <span class="eyebrow">HOSTING CONTROL CENTER</span>
      <h1>Your projects.<br /><span>Under control.</span></h1>
      <p>Deploy and manage Python and Node.js applications from Telegram.</p>
      <div class="status"><i></i> Control plane initialized</div>
    </section>
    <section class="grid">
      <article><b>Python</b><p>Isolated Python application workloads.</p></article>
      <article><b>Node.js</b><p>Managed Node.js application workloads.</p></article>
      <article><b>Projects</b><p>Deployments, logs, files and backups.</p></article>
      <article><b>Admin</b><p>Plans, billing, users and infrastructure.</p></article>
    </section>
    <footer>Open this app from your HostPilot Telegram bot. Setup and authentication are required.</footer>
  </main>;
}
render(<App />, document.getElementById("app")!);