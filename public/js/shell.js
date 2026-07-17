/** Shared app shell: mobile sidebar toggle */
(function () {
  const btn = document.getElementById("menuBtn");
  const side = document.getElementById("sidebar");
  const back = document.getElementById("sidebarBackdrop");
  if (!btn || !side) return;
  function close() {
    side.classList.remove("open");
    if (back) back.classList.remove("open");
  }
  function open() {
    side.classList.add("open");
    if (back) back.classList.add("open");
  }
  btn.addEventListener("click", () => {
    if (side.classList.contains("open")) close();
    else open();
  });
  if (back) back.addEventListener("click", close);
})();
