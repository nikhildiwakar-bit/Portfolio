// ===== Edit your projects here =====
const projects = [
  { title: "Portfolio Website", category: "web", description: "This responsive personal portfolio with dark mode, animations and project filtering.", tags: ["HTML", "CSS", "JavaScript"], demo: "#", code: "https://github.com/nikhildiwakar-bit/Portfolio" },
  { title: "Task Manager App", category: "app", description: "A to-do app with categories, due dates and local storage persistence.", tags: ["React", "LocalStorage"], demo: "#", code: "#" },
  { title: "Weather Dashboard", category: "web", description: "Search any city and see current weather and a 5-day forecast using a public API.", tags: ["JavaScript", "API"], demo: "#", code: "#" },
  { title: "Expense Tracker", category: "app", description: "Track income and expenses with charts and monthly summaries.", tags: ["Node.js", "Chart.js"], demo: "#", code: "#" },
  { title: "CLI File Organizer", category: "tool", description: "A Python script that sorts files in a folder by type and date.", tags: ["Python", "CLI"], demo: "#", code: "#" },
  { title: "URL Shortener", category: "tool", description: "A tiny REST API that shortens URLs and tracks click counts.", tags: ["Express", "SQL"], demo: "#", code: "#" },
];

const grid = document.getElementById("projects-grid");
function renderProjects(filter = "all") {
  grid.innerHTML = projects
    .filter(p => filter === "all" || p.category === filter)
    .map(p => `
      <article class="card project">
        <h3>${p.title}</h3>
        <p>${p.description}</p>
        <ul class="tags">${p.tags.map(t => `<li>${t}</li>`).join("")}</ul>
        <div class="links">
          <a href="${p.demo}" target="_blank" rel="noopener">Live ↗</a>
          <a href="${p.code}" target="_blank" rel="noopener">Code ↗</a>
        </div>
      </article>`).join("");
}
renderProjects();

document.querySelectorAll(".filter").forEach(btn =>
  btn.addEventListener("click", () => {
    document.querySelector(".filter.active").classList.remove("active");
    btn.classList.add("active");
    renderProjects(btn.dataset.filter);
  })
);

// Typing effect
const words = ["websites.", "web apps.", "useful tools.", "clean UIs."];
const typedEl = document.getElementById("typed-text");
let w = 0, c = 0, deleting = false;
(function type() {
  const word = words[w];
  typedEl.textContent = word.slice(0, c);
  if (!deleting && c < word.length) c++;
  else if (deleting && c > 0) c--;
  else { deleting = !deleting; if (!deleting) w = (w + 1) % words.length; }
  setTimeout(type, deleting ? 50 : c === word.length ? 1500 : 100);
})();

// Theme toggle
const themeBtn = document.querySelector(".theme-toggle");
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
  try { localStorage.setItem("theme", t); } catch {}
}
let saved = null;
try { saved = localStorage.getItem("theme"); } catch {}
setTheme(saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
themeBtn.addEventListener("click", () =>
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

// Mobile menu
const menuBtn = document.querySelector(".menu-toggle");
const links = document.querySelector(".nav-links");
menuBtn.addEventListener("click", () => {
  const open = links.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", open);
});
links.querySelectorAll("a").forEach(a => a.addEventListener("click", () => links.classList.remove("open")));

// Reveal on scroll
const observer = new IntersectionObserver(entries =>
  entries.forEach(e => e.isIntersecting && e.target.classList.add("visible")), { threshold: 0.15 });
document.querySelectorAll(".reveal").forEach(el => observer.observe(el));

// Contact form (opens mail client; swap for Formspree etc. if desired)
document.getElementById("contact-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = encodeURIComponent(`${f.get("message")}\n\n— ${f.get("name")} (${f.get("email")})`);
  window.location.href = `mailto:you@example.com?subject=${encodeURIComponent("Portfolio contact")}&body=${body}`;
});

document.getElementById("year").textContent = new Date().getFullYear();
