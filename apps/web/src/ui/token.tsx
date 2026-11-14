const copyScript = `
const copy = document.getElementById("copy-token");
if (copy && navigator.clipboard) {
  copy.hidden = false;
  copy.addEventListener("click", async () => {
    const token = document.getElementById("issued-token");
    await navigator.clipboard.writeText(token.textContent.trim());
    copy.textContent = "Copied";
  });
}
`;

export function TokenDisplay({ token }: { token: string }) {
  return (
    <div class="token-box">
      <code id="issued-token">{token}</code>
      <button class="pill small" id="copy-token" type="button" hidden>
        Copy
      </button>
      <script type="module" dangerouslySetInnerHTML={{ __html: copyScript }} />
    </div>
  );
}
