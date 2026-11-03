const one = document.getElementById("one");
const five = document.getElementById("five");
const approve = document.getElementById("approve");
const restart = document.getElementById("restart");
const decision = document.getElementById("decision");
const finding = document.getElementById("finding");
let reviews = 0;

five.addEventListener("click", () => {
  finding.textContent = "Check the numbers again. Every row carries declaration 3631.";
  restart.disabled = false;
});

one.addEventListener("click", () => {
  finding.textContent = "Supported. Five Virginia counties appear in the sample for declaration 3631. The sample alone cannot establish the full affected area.";
  one.disabled = five.disabled = true;
  approve.disabled = restart.disabled = false;
  decision.textContent = "Awaiting two independent reviews of this wording.";
  approve.focus();
});

approve.addEventListener("click", () => {
  reviews += 1;
  if (reviews === 1) {
    decision.textContent = "1 of 2 approvals. The handoff is pending.";
    approve.textContent = "Approve as Reviewer 2";
  } else {
    decision.textContent = "2 of 2 approvals. The receiving team can trace the approved brief to the five source rows.";
    approve.textContent = "Handoff complete";
    approve.disabled = true;
    restart.focus();
  }
});

restart.addEventListener("click", () => {
  reviews = 0;
  one.disabled = five.disabled = false;
  approve.disabled = restart.disabled = true;
  approve.textContent = "Approve as Reviewer 1";
  finding.textContent = "Compare the declaration number on each row.";
  decision.textContent = "Choose a supported claim to open review.";
  five.focus();
});
