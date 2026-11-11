import "./style.css"
import { createPeople } from "./people.js"

const cleanup = createPeople(
  document.querySelector("#people"),
  document.querySelector("#motion")
)
const dialog = document.querySelector("#about")
let opener
for (const button of document.querySelectorAll("[data-about]")) {
  button.addEventListener("click", () => {
    opener = button
    dialog.showModal()
  })
}
dialog.querySelector(".close").addEventListener("click", () => dialog.close())
dialog.addEventListener("click", (event) => {
  const box = dialog.getBoundingClientRect()
  if (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
    dialog.close()
})
dialog.addEventListener("close", () => opener?.focus())
if (import.meta.hot) import.meta.hot.dispose(cleanup)
