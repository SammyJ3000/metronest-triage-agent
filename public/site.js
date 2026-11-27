const revealItems = [...document.querySelectorAll("[data-reveal]")];
const floatCards = [...document.querySelectorAll("[data-float-card]")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.18 }
);

revealItems.forEach((item) => observer.observe(item));

const hero = document.querySelector(".hero-section");
const productStage = document.querySelector("[data-product-stage]");
const morphSources = [...document.querySelectorAll("[data-morph-source]")];
const morphPairs = morphSources
  .map((source) => ({
    source,
    target: document.querySelector(`[data-morph-target="${source.dataset.morphSource}"]`),
  }))
  .filter((pair) => pair.target);
const staticStageCards = productStage
  ? [...productStage.querySelectorAll(".rise-data-card:not([data-morph-target])")]
  : [];

if (hero && floatCards.length && !reduceMotion) {
  hero.addEventListener("pointermove", (event) => {
    const bounds = hero.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;

    floatCards.forEach((card, index) => {
      if (card.dataset.morphing === "true") return;
      const depth = 10 + index * 4;
      card.style.transform = `translate(${x * depth}px, ${y * depth}px)`;
    });
  });

  hero.addEventListener("pointerleave", () => {
    floatCards.forEach((card) => {
      card.style.transform = "";
    });
  });
}

if (hero && productStage && morphPairs.length && !reduceMotion) {
  const resetMorph = () => {
    hero.style.zIndex = "";
    productStage.dataset.morphState = "resting";
    morphPairs.forEach(({ source, target }) => {
      source.dataset.morphing = "false";
      source.style.position = "";
      source.style.left = "";
      source.style.top = "";
      source.style.width = "";
      source.style.zIndex = "";
      source.style.pointerEvents = "";
      source.style.animation = "";
      source.style.transform = "";
      source.style.opacity = "";
      source.style.visibility = "";
      source.style.transformOrigin = "";
      source.removeAttribute("data-origin-left");
      source.removeAttribute("data-origin-top");
      source.removeAttribute("data-origin-width");
      target.style.opacity = "0";
      target.style.transform = "";
    });
    staticStageCards.forEach((card) => {
      card.style.opacity = "0";
      card.style.transform = "";
    });
  };

  const updateMorph = () => {
    if (window.innerWidth < 900) {
      resetMorph();
      return;
    }

    const stageTop = productStage.getBoundingClientRect().top;
    const rawProgress = (window.innerHeight * 0.82 - stageTop) / (window.innerHeight * 0.85);
    const progress = smoothstep(clamp(rawProgress, 0, 1));

    if (progress <= 0.01) {
      resetMorph();
      return;
    }

    productStage.dataset.morphState = progress >= 0.985 ? "settled" : "flying";
    hero.style.zIndex = progress >= 0.985 ? "" : "20";

    morphPairs.forEach(({ source, target }) => {
      if (!source.dataset.originLeft) {
        const origin = source.getBoundingClientRect();
        source.dataset.originLeft = String(origin.left);
        source.dataset.originTop = String(origin.top);
        source.dataset.originWidth = String(origin.width);
      }

      const originLeft = Number(source.dataset.originLeft);
      const originTop = Number(source.dataset.originTop);
      const originWidth = Number(source.dataset.originWidth);
      const targetRect = target.getBoundingClientRect();
      const targetScale = Math.min(targetRect.width / originWidth, 1.22);
      const scale = 1 + (targetScale - 1) * progress;
      const translateX = (targetRect.left - originLeft) * progress;
      const translateY = (targetRect.top - originTop) * progress;

      source.dataset.morphing = "true";
      source.style.position = "fixed";
      source.style.left = `${originLeft}px`;
      source.style.top = `${originTop}px`;
      source.style.width = `${originWidth}px`;
      source.style.zIndex = "80";
      source.style.pointerEvents = "none";
      source.style.animation = "none";
      source.style.transformOrigin = "top left";
      source.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
      source.style.opacity = String(clamp(1 - Math.max(0, progress - 0.94) / 0.055, 0, 1));
      source.style.visibility = progress > 0.992 ? "hidden" : "visible";
      target.style.opacity = String(clamp((progress - 0.955) / 0.045, 0, 1));
      target.style.transform = `scale(${0.985 + 0.015 * clamp((progress - 0.955) / 0.045, 0, 1)})`;

      if (progress >= 0.995) {
        source.style.opacity = "0";
        source.style.visibility = "hidden";
        target.style.opacity = "1";
        target.style.transform = "scale(1)";
      }
    });

    staticStageCards.forEach((card, index) => {
      const appear = clamp((progress - 0.965 - index * 0.012) / 0.04, 0, 1);
      card.style.opacity = String(appear);
      card.style.transform = `translateY(${(1 - appear) * 10}px)`;
    });
  };

  updateMorph();
  window.addEventListener("scroll", updateMorph, { passive: true });
  window.addEventListener("resize", updateMorph);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}
