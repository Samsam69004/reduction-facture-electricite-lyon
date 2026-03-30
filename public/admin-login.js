const form = document.getElementById("login-form");
const msg = document.getElementById("msg");
const btn = document.getElementById("btn");

if (form && msg && btn) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    msg.textContent = "";
    msg.className = "msg";

    const payload = { password: form.password.value };

    btn.disabled = true;
    btn.textContent = "Connexion...";

    try {
      const response = await fetch("/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.message || "Connexion impossible");
      }

      window.location.href = "/admin";
    } catch (error) {
      msg.textContent = error.message || "Erreur";
      msg.classList.add("err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Se connecter";
    }
  });
}
