<script>
  import { captureSvelteError, setLogBrewContext } from "@logbrew/svelte";

  let { logbrew } = $props();
  setLogBrewContext(logbrew);
  let paying = $state(false);
  console.info("checkout started");

  function charge() {
    console.warn("payment step failing");
    throw new Error("payment declined");
  }
</script>

<svelte:boundary onerror={(error) => captureSvelteError(error, logbrew, { component: "Checkout" })}>
  <button id="pay" onclick={() => (paying = true)}>Pay</button>
  {#if paying}<p>{charge()}</p>{/if}
  {#snippet failed()}<p>Payment failed</p>{/snippet}
</svelte:boundary>
