#include <jni.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <dlfcn.h>
#include <elf.h>
#include <fcntl.h>
#include <link.h>
#include <signal.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <ucontext.h>

namespace {
constexpr uint32_t kMagic = 0x4c424e53;
constexpr uint32_t kVersion = 1;
constexpr size_t kIdBytes = 96;
constexpr size_t kUuidBytes = 36;
constexpr size_t kArchBytes = 16;
constexpr size_t kOffsetBytes = 16;
constexpr size_t kProjectChars = 36;
constexpr size_t kReleaseChars = 256;
constexpr size_t kEnvironmentChars = 128;
constexpr size_t kServiceChars = 128;
constexpr size_t kMaxModules = 4096;
constexpr std::array<int, 6> kSignals = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};

#pragma pack(push, 1)
struct SignalRecord {
  uint32_t magic;
  uint32_t version;
  uint32_t signal;
  uint64_t timestamp_ms;
  char event_id[kIdBytes];
  char image_uuid[kUuidBytes];
  char architecture[kArchBytes];
  char instruction_offset[kOffsetBytes];
  uint16_t project_id[kProjectChars];
  uint16_t release[kReleaseChars];
  uint16_t environment[kEnvironmentChars];
  uint16_t service[kServiceChars];
  uint32_t checksum;
};
#pragma pack(pop)
static_assert(sizeof(SignalRecord) == 1284, "signal record layout drifted");

struct Module {
  uintptr_t start;
  uintptr_t end;
  std::array<uint8_t, 16> build_id;
  bool has_build_id;
};

std::array<Module, kMaxModules> g_modules{};
size_t g_module_count = 0;
bool g_module_overflow = false;
std::array<struct sigaction, kSignals.size()> g_previous_actions{};
std::array<char, 1024> g_record_path{};
SignalRecord g_record_template{};
std::atomic<bool> g_installed{false};
std::atomic_flag g_handling = ATOMIC_FLAG_INIT;

uint32_t crc32(const uint8_t* bytes, size_t length) {
  uint32_t value = 0xffffffffU;
  for (size_t index = 0; index < length; ++index) {
    value ^= bytes[index];
    for (int bit = 0; bit < 8; ++bit) {
      value = (value >> 1U) ^ (0xedb88320U & (0U - (value & 1U)));
    }
  }
  return value ^ 0xffffffffU;
}

size_t align4(size_t value) {
  return (value + 3U) & ~size_t{3U};
}

bool read_build_id(const dl_phdr_info* info, std::array<uint8_t, 16>* output) {
  for (ElfW(Half) index = 0; index < info->dlpi_phnum; ++index) {
    const ElfW(Phdr)& header = info->dlpi_phdr[index];
    if (header.p_type != PT_NOTE || header.p_memsz < sizeof(ElfW(Nhdr))) {
      continue;
    }
    const auto* cursor = reinterpret_cast<const uint8_t*>(info->dlpi_addr + header.p_vaddr);
    const auto* end = cursor + header.p_memsz;
    while (cursor + sizeof(ElfW(Nhdr)) <= end) {
      const auto* note = reinterpret_cast<const ElfW(Nhdr)*>(cursor);
      cursor += sizeof(ElfW(Nhdr));
      const size_t name_bytes = align4(note->n_namesz);
      const size_t value_bytes = align4(note->n_descsz);
      if (cursor + name_bytes + value_bytes > end) {
        break;
      }
      const uint8_t* name = cursor;
      const uint8_t* value = cursor + name_bytes;
      if (note->n_type == NT_GNU_BUILD_ID
          && note->n_namesz >= 3
          && std::memcmp(name, "GNU", 3) == 0
          && note->n_descsz >= output->size()) {
        std::memcpy(output->data(), value, output->size());
        return true;
      }
      cursor += name_bytes + value_bytes;
    }
  }
  return false;
}

int collect_module(dl_phdr_info* info, size_t, void*) {
  if (g_module_count == g_modules.size()) {
    g_module_overflow = true;
    return 1;
  }
  uintptr_t start = UINTPTR_MAX;
  uintptr_t end = 0;
  for (ElfW(Half) index = 0; index < info->dlpi_phnum; ++index) {
    const ElfW(Phdr)& header = info->dlpi_phdr[index];
    if (header.p_type != PT_LOAD) {
      continue;
    }
    const uintptr_t segment_start = info->dlpi_addr + header.p_vaddr;
    start = segment_start < start ? segment_start : start;
    const uintptr_t segment_end = segment_start + header.p_memsz;
    end = segment_end > end ? segment_end : end;
  }
  if (start == UINTPTR_MAX || end <= start) {
    return 0;
  }
  Module module{};
  module.start = start;
  module.end = end;
  module.has_build_id = read_build_id(info, &module.build_id);
  g_modules[g_module_count++] = module;
  return 0;
}

uintptr_t program_counter(void* context) {
  const auto* machine = reinterpret_cast<const ucontext_t*>(context);
#if defined(__aarch64__)
  return machine->uc_mcontext.pc;
#elif defined(__arm__)
  return machine->uc_mcontext.arm_pc;
#elif defined(__x86_64__)
  return machine->uc_mcontext.gregs[REG_RIP];
#elif defined(__i386__)
  return machine->uc_mcontext.gregs[REG_EIP];
#else
  return 0;
#endif
}

const char* architecture() {
#if defined(__aarch64__)
  return "arm64";
#elif defined(__arm__)
  return "arm";
#elif defined(__x86_64__)
  return "x86_64";
#elif defined(__i386__)
  return "x86";
#else
  return "";
#endif
}

const Module* module_for(uintptr_t address) {
  for (size_t index = 0; index < g_module_count; ++index) {
    const Module& module = g_modules[index];
    if (module.has_build_id && address >= module.start && address < module.end) {
      return &module;
    }
  }
  return nullptr;
}

void uuid_string(const std::array<uint8_t, 16>& bytes, char* output) {
  static constexpr char hex[] = "0123456789abcdef";
  size_t destination = 0;
  for (size_t index = 0; index < bytes.size(); ++index) {
    if (index == 4 || index == 6 || index == 8 || index == 10) {
      output[destination++] = '-';
    }
    output[destination++] = hex[bytes[index] >> 4U];
    output[destination++] = hex[bytes[index] & 0x0fU];
  }
}

void offset_string(uintptr_t value, char* output) {
  static constexpr char hex[] = "0123456789abcdef";
  for (int index = 15; index >= 0; --index) {
    output[index] = hex[value & 0x0fU];
    value >>= 4U;
  }
}

void write_record(int signal_number, void* context) {
  const uintptr_t address = program_counter(context);
  const Module* module = module_for(address);
  if (module == nullptr || address < module->start) {
    return;
  }
  SignalRecord record = g_record_template;
  record.signal = static_cast<uint32_t>(signal_number);
  timespec now{};
  if (clock_gettime(CLOCK_REALTIME, &now) != 0) {
    return;
  }
  record.timestamp_ms = static_cast<uint64_t>(now.tv_sec) * 1000U
      + static_cast<uint64_t>(now.tv_nsec / 1000000U);
  uuid_string(module->build_id, record.image_uuid);
  const char* arch = architecture();
  size_t arch_length = 0;
  while (arch[arch_length] != '\0') {
    ++arch_length;
  }
  std::memcpy(record.architecture, arch, arch_length);
  offset_string(address - module->start, record.instruction_offset);
  record.checksum = crc32(reinterpret_cast<const uint8_t*>(&record), sizeof(record) - 4);

  const int descriptor = open(
      g_record_path.data(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0) {
    return;
  }
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  size_t written = 0;
  while (written < sizeof(record)) {
    const ssize_t count = write(descriptor, bytes + written, sizeof(record) - written);
    if (count <= 0) {
      break;
    }
    written += static_cast<size_t>(count);
  }
  if (written == sizeof(record)) {
    fsync(descriptor);
  }
  close(descriptor);
}

void chain_signal(int signal_number) {
  for (size_t index = 0; index < kSignals.size(); ++index) {
    if (kSignals[index] == signal_number) {
      sigaction(signal_number, &g_previous_actions[index], nullptr);
      break;
    }
  }
  syscall(SYS_tgkill, getpid(), gettid(), signal_number);
}

void signal_handler(int signal_number, siginfo_t*, void* context) {
  if (!g_handling.test_and_set()) {
    write_record(signal_number, context);
  }
  chain_signal(signal_number);
}

bool copy_jstring(JNIEnv* environment, jstring value, char* output, size_t capacity) {
  if (value == nullptr) {
    return false;
  }
  const char* bytes = environment->GetStringUTFChars(value, nullptr);
  if (bytes == nullptr) {
    return false;
  }
  const size_t length = std::strlen(bytes);
  const bool valid = length > 0 && length < capacity;
  if (valid) {
    std::memset(output, 0, capacity);
    std::memcpy(output, bytes, length);
  }
  environment->ReleaseStringUTFChars(value, bytes);
  return valid;
}

bool copy_jstring_utf16(
    JNIEnv* environment, jstring value, uint16_t* output, size_t capacity) {
  if (value == nullptr) {
    return false;
  }
  const jsize length = environment->GetStringLength(value);
  if (length <= 0 || static_cast<size_t>(length) > capacity) {
    return false;
  }
  std::memset(output, 0, capacity * sizeof(uint16_t));
  environment->GetStringRegion(value, 0, length, reinterpret_cast<jchar*>(output));
  return !environment->ExceptionCheck();
}
}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_co_logbrew_reactnative_AndroidDiagnosticsRuntime_nativeInstall(
    JNIEnv* environment,
    jclass,
    jstring record_path,
    jstring event_id,
    jstring project_id,
    jstring release,
    jstring deployment_environment,
    jstring service) {
  bool expected = false;
  if (!g_installed.compare_exchange_strong(expected, true)) {
    return JNI_FALSE;
  }
  if (!copy_jstring(environment, record_path, g_record_path.data(), g_record_path.size())
      || !copy_jstring(
          environment,
          event_id,
          g_record_template.event_id,
          sizeof(g_record_template.event_id))
      || !copy_jstring_utf16(
          environment,
          project_id,
          g_record_template.project_id,
          kProjectChars)
      || !copy_jstring_utf16(
          environment, release, g_record_template.release, kReleaseChars)
      || !copy_jstring_utf16(
          environment,
          deployment_environment,
          g_record_template.environment,
          kEnvironmentChars)
      || !copy_jstring_utf16(
          environment, service, g_record_template.service, kServiceChars)) {
    g_installed.store(false);
    return JNI_FALSE;
  }
  g_record_template.magic = kMagic;
  g_record_template.version = kVersion;
  g_module_count = 0;
  g_module_overflow = false;
  dl_iterate_phdr(collect_module, nullptr);
  if (g_module_overflow) {
    g_installed.store(false);
    return JNI_FALSE;
  }
  struct sigaction action {};
  sigemptyset(&action.sa_mask);
  action.sa_sigaction = signal_handler;
  action.sa_flags = SA_SIGINFO | SA_ONSTACK;
  for (size_t index = 0; index < kSignals.size(); ++index) {
    if (sigaction(kSignals[index], &action, &g_previous_actions[index]) != 0) {
      for (size_t rollback = 0; rollback < index; ++rollback) {
        sigaction(kSignals[rollback], &g_previous_actions[rollback], nullptr);
      }
      g_installed.store(false);
      return JNI_FALSE;
    }
  }
  return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_co_logbrew_reactnative_AndroidDiagnosticsRuntime_nativeUninstall(JNIEnv*, jclass) {
  if (!g_installed.exchange(false)) {
    return;
  }
  for (size_t index = 0; index < kSignals.size(); ++index) {
    struct sigaction current {};
    if (sigaction(kSignals[index], nullptr, &current) == 0
        && (current.sa_flags & SA_SIGINFO) != 0
        && current.sa_sigaction == signal_handler) {
      sigaction(kSignals[index], &g_previous_actions[index], nullptr);
    }
  }
  g_handling.clear();
}
