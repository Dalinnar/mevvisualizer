# 🧱 MeVVisualizer

**MeVVisualizer** is a lightweight, high-performance web renderer for **Minecraft Litematics**, built as part of **MineMeV (Minecraft Engineers Vault)**.

It focuses on accurate rendering, smooth interaction, and practical tools for engineers working with large structures.

---

## 🚀 Features

* 📦 **Litematic Support**

  * Load and visualize `.litematic` files directly in the browser

* 🧩 **Multi-Region Support**

  * Correctly handles structures composed of multiple regions

* 📊 **Material List Included**

  * Automatically calculates and displays required materials

* 🔍 **Slice Viewer**

  * Inspect structures layer by layer (X/Y/Z slicing)

* ⚡ **High Performance**

  * Optimized rendering pipeline using WebGL
  * Efficient handling of large builds

* 🧠 **Accurate Block Rendering**

  * Correct visualization of complex blocks:

    * Chests
    * Redstone
    * Orientation-sensitive blocks

* 🎯 **No Visual Glitches**

  * Clean and reliable rendering with no known major issues

---

## 🛠️ Tech Stack

* WebGL
* JavaScript (ES Modules)
* [deepslate@0.25.1](https://unpkg.com/deepslate@0.25.1)

---

## 📂 Project Structure

```
.
├── src/            # Renderer logic
├── index.html      # Entry point
└── .gitignore
```

---

## 🌐 Live Demo

Available via GitHub Pages:

```
https://dalinnar.github.io/mevvisualizer/
```

---

## ⚙️ Usage

1. Open the app in your browser
2. Load a `.litematic` file
3. Navigate using mouse controls
4. Use slice controls to inspect layers
5. Check the material list for build requirements

---

## 🎮 Controls

* **Left Click + Drag** → Rotate
* **Scroll** → Zoom
* **(Optional)** Slice controls → Change visible layers

---

## 📌 Notes

* Uses the latest **deepslate** version via CDN
* Designed for engineers and technical Minecraft players
* Works entirely client-side (no backend required)

---

## 🧑‍💻 Author Dalinnar

Built by **MineMeV**

