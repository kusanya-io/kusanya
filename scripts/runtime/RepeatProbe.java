import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.io.*;
import java.util.*;
import org.javarosa.core.model.*;
import org.javarosa.core.model.data.*;
import org.javarosa.core.model.instance.*;
import org.javarosa.form.api.*;
import org.javarosa.xform.parse.XFormParser;
import org.javarosa.model.xform.XFormSerializingVisitor;

/** Synthetic headless engine probe; not evidence of the Collect Android UI. */
public final class RepeatProbe {
  static FormEntryController load(String xml, String saved) throws Exception {
    XFormParser parser = saved == null ? new XFormParser(new StringReader(xml))
        : new XFormParser(new StringReader(xml), new StringReader(saved));
    FormDef form = parser.parse();
    FormEntryController controller = new FormEntryController(new FormEntryModel(form));
    form.initialize(saved == null, new InstanceInitializationFactory());
    return controller;
  }
  static void traverse(FormEntryController controller, int[] answers) {
    traverse(controller, answers, "member_count", null);
  }
  static void traverse(FormEntryController controller, int[] answers, String countName, Integer rootCount) {
    traverse(controller, answers, countName, rootCount, true);
  }
  static void traverse(FormEntryController controller, int[] answers, String countName, Integer rootCount, boolean fillText) {
    controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
    int countAnswer = 0;
    for (int steps = 0; steps < 500; steps++) {
      int event = controller.stepToNextEvent();
      if (event == FormEntryController.EVENT_END_OF_FORM) {
        if (answers != null && countAnswer != answers.length) throw new AssertionError("Missing count questions");
        return;
      }
      if (event == FormEntryController.EVENT_QUESTION) {
        TreeElement element = controller.getModel().getForm().getMainInstance().resolveReference(controller.getModel().getFormIndex().getReference());
        if (answers != null && countName.equals(element.getName())) {
          if (countAnswer >= answers.length) throw new AssertionError("Unexpected count question");
          int status = controller.answerQuestion(new IntegerData(answers[countAnswer++]), true);
          if (status != FormEntryController.ANSWER_OK) throw new AssertionError("Rejected synthetic count " + status);
        } else if (rootCount != null && "root_count".equals(element.getName())) {
          if (controller.answerQuestion(new IntegerData(rootCount), true) != FormEntryController.ANSWER_OK)
            throw new AssertionError("Rejected synthetic root count");
        } else if (fillText && answers != null && textName(element.getName())) {
          String syntheticValue = "synthetic:" + element.getRef().toString();
          if (controller.answerQuestion(new StringData(syntheticValue), true) != FormEntryController.ANSWER_OK)
            throw new AssertionError("Rejected synthetic text");
        }
      }
    }
    throw new AssertionError("Traversal exceeded 500 events");
  }
  static List<TreeElement> children(TreeElement parent, String name) {
    return parent.getChildrenWithName(name).stream().filter(c -> c.getMultiplicity() >= 0).toList();
  }
  static int[] counts(FormEntryController controller, String name) {
    return children(controller.getModel().getForm().getMainInstance().getRoot(), "families")
      .stream().mapToInt(f -> children(f, name).size()).toArray();
  }
  static void expect(FormEntryController controller, String label, int[] memberCounts) {
    int[] members = counts(controller, "members");
    int[] checks = counts(controller, "checks");
    if (!Arrays.equals(members, memberCounts) || !Arrays.equals(checks, new int[]{3,3}))
      throw new AssertionError(label + " counts members=" + Arrays.toString(members) + " checks=" + Arrays.toString(checks));
    System.out.println(label + " members=" + Arrays.toString(members) + " checks=" + Arrays.toString(checks));
  }
  static String serialize(FormEntryController controller) throws Exception {
    return new String(new XFormSerializingVisitor().serializeInstance(controller.getModel().getForm().getMainInstance()), StandardCharsets.UTF_8);
  }
  static Map<String,String> values(FormEntryController controller) {
    Map<String,String> output = new TreeMap<>();
    collectValues(controller.getModel().getForm().getMainInstance().getRoot(), output);
    return output;
  }
  static void collectValues(TreeElement element, Map<String,String> output) {
    if (element.getMultiplicity() < 0) return;
    if (textName(element.getName())) {
      if (element.getValue() == null) throw new AssertionError("Synthetic answer unexpectedly empty");
      output.put(element.getRef().toString(), String.valueOf(element.getValue().getValue()));
    }
    for (int i = 0; i < element.getNumChildren(); i++) collectValues(element.getChildAt(i), output);
  }
  static boolean textName(String name) {
    return Set.of("member_name", "check_note", "once_note", "person_note", "root_note").contains(name);
  }
  static String instanceId(FormEntryController controller) {
    String value = String.valueOf(controller.getModel().getForm().getMainInstance().getRoot().getChild("meta",0).getChild("instanceID",0).getValue().getValue());
    if (!value.matches("uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
      throw new AssertionError("InstanceID is not a nonempty UUID: length=" + value.length());
    return value;
  }
  static void sourceCounts(FormEntryController controller, String name, int[] expected) {
    List<Integer> actual = new ArrayList<>();
    collectSourceCounts(controller.getModel().getForm().getMainInstance().getRoot(), name, actual);
    int[] found = actual.stream().mapToInt(Integer::intValue).toArray();
    if (!Arrays.equals(found, expected)) throw new AssertionError("Unexpected stored source " + name + "=" + Arrays.toString(found));
  }
  static void collectSourceCounts(TreeElement element, String name, List<Integer> values) {
    if (element.getMultiplicity() < 0) return;
    if (name.equals(element.getName())) {
      if (element.getValue() == null || !(element.getValue().getValue() instanceof Number))
        throw new AssertionError("Stored source count missing or not numeric");
      Number value = (Number) element.getValue().getValue();
      if (value.doubleValue() != value.intValue()) throw new AssertionError("Stored source count is fractional");
      values.add(value.intValue());
    }
    for (int i = 0; i < element.getNumChildren(); i++) collectSourceCounts(element.getChildAt(i), name, values);
  }
  public static void main(String[] args) throws Exception {
    if (args.length != 2) throw new IllegalArgumentException("Provide synthetic compiled nested and section XForms");
    new org.javarosa.model.xform.XFormsModule().registerModule();
    String xml = Files.readString(Path.of(args[0]));
    FormEntryController defaults = load(xml, null);
    traverse(defaults, null);
    expect(defaults, "default-zero-per-family", new int[]{0,0});
    FormEntryController distinct = load(xml, null);
    traverse(distinct, new int[]{2,3});
    expect(distinct, "distinct-2-and-3", new int[]{2,3});
    sourceCounts(distinct, "member_count", new int[]{2,3});
    Map<String,String> originalValues = values(distinct);
    if (originalValues.size() != 12) throw new AssertionError("Expected 5 members + 6 fixed checks + once-only answer");
    String originalId = instanceId(distinct);
    if (originalId.equals(instanceId(defaults))) throw new AssertionError("Two new instances share an ID");
    String saved = serialize(distinct);
    Files.writeString(Path.of(args[0]).getParent().resolve("nested-draft.xml"), saved, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
    FormEntryController resumed = load(xml, saved);
    traverse(resumed, null);
    expect(resumed, "serialized-and-resumed", new int[]{2,3});
    sourceCounts(resumed, "member_count", new int[]{2,3});
    if (!originalId.equals(instanceId(resumed))) throw new AssertionError("Nested instanceID changed on reload");
    System.out.println("instanceID stable across reload=true");
    if (!originalValues.equals(values(resumed))) throw new AssertionError("Instance reload changed repeated answers");
    System.out.println("serialized-and-resumed preserved 11 distinct repeated answers and one once-only answer");
    FormEntryController zero = load(xml, null);
    traverse(zero, new int[]{0,0});
    expect(zero, "initial-zero", new int[]{0,0});
    sourceCounts(zero, "member_count", new int[]{0,0});
    traverse(zero, new int[]{2,3});
    expect(zero, "zero-to-positive", new int[]{2,3});
    sourceCounts(zero, "member_count", new int[]{2,3});
    Map<String,String> beforeReduction = values(zero);
    String beforeReductionId = instanceId(zero);
    traverse(zero, new int[]{1,1}, "member_count", null, false);
    expect(zero, "reduction-retains-existing", new int[]{2,3});
    sourceCounts(zero, "member_count", new int[]{1,1});
    if (!beforeReduction.equals(values(zero))) throw new AssertionError("Reduction changed existing answers");
    String reducedSaved = serialize(zero);
    Files.writeString(Path.of(args[0]).getParent().resolve("nested-reduced.xml"), reducedSaved, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
    FormEntryController reducedReload = load(xml, reducedSaved);
    traverse(reducedReload, null);
    expect(reducedReload, "reduced-draft-resumed", new int[]{2,3});
    sourceCounts(reducedReload, "member_count", new int[]{1,1});
    if (!beforeReduction.equals(values(reducedReload))) throw new AssertionError("Reduced draft reload changed answers");
    if (!beforeReductionId.equals(instanceId(reducedReload))) throw new AssertionError("Reduced draft reload changed ID");
    String negative = xml.replace("jr:count=\"../member_count\"", "jr:count=\"../../_ksny_count_families\"");
    if (negative.equals(xml)) throw new AssertionError("Negative-control mutation missed");
    FormEntryController wrong = load(negative, null);
    traverse(wrong, null);
    int[] wrongCounts = counts(wrong, "members");
    if (!Arrays.equals(wrongCounts, new int[]{2,2})) throw new AssertionError("Negative control did not demonstrate wrong context: " + Arrays.toString(wrongCounts));
    System.out.println("negative-context-control detected members=" + Arrays.toString(wrongCounts) + " expected=[0, 0]");
    // Reproduce the complete previous compiler metadata, rather than claiming
    // that removing once alone changes JavaRosa's namespaced restore behavior.
    if (!xml.contains("once(concat(&apos;uuid:&apos;, uuid()))") || !xml.contains("<orx:meta>") || !xml.contains("<orx:instanceID/>"))
      throw new AssertionError("Negative ID baseline metadata changed");
    String idNegative = xml.replace("once(concat(&apos;uuid:&apos;, uuid()))", "concat(&apos;uuid:&apos;, uuid())")
      .replace("orx:meta", "meta").replace("orx:instanceID", "instanceID");
    if (idNegative.equals(xml)) throw new AssertionError("Negative ID mutation missed");
    FormEntryController wrongId = load(idNegative, null);
    traverse(wrongId, null);
    String beforeWrongId = instanceId(wrongId);
    FormEntryController wrongIdReloaded = load(idNegative, serialize(wrongId));
    if (beforeWrongId.equals(instanceId(wrongIdReloaded))) throw new AssertionError("Negative ID control did not detect regeneration");
    System.out.println("negative-instanceID-control detected regeneration across reload");
    sectionChecks(Files.readString(Path.of(args[1])), Path.of(args[1]).getParent());
    System.out.println("PASS JavaRosa 6.0.0 real FormEntryController repeat traversal; no Collect UI claim");
  }
  static void sectionCounts(FormEntryController controller, String label, int[] expectedPeople, int[] expectedRoot) {
    List<TreeElement> households = children(controller.getModel().getForm().getMainInstance().getRoot(), "households");
    int[] people = households.stream().mapToInt(h -> children(h.getChild("survey",0), "people").size()).toArray();
    int[] rooted = households.stream().mapToInt(h -> children(h, "root_counted").size()).toArray();
    if (!Arrays.equals(people, expectedPeople) || !Arrays.equals(rooted, expectedRoot))
      throw new AssertionError(label + " people=" + Arrays.toString(people) + " root_counted=" + Arrays.toString(rooted));
    System.out.println(label + " people=" + Arrays.toString(people) + " root_counted=" + Arrays.toString(rooted));
  }
  static void sectionChecks(String xml, Path output) throws Exception {
    FormEntryController section = load(xml, null);
    traverse(section, null, "member_limit", null);
    sectionCounts(section, "section-default-zero", new int[]{0,0}, new int[]{1,1});
    sourceCounts(section, "member_limit", new int[]{0,0});
    sourceCounts(section, "root_count", new int[]{1});
    traverse(section, new int[]{2,3}, "member_limit", null);
    sectionCounts(section, "section-independent-counts", new int[]{2,3}, new int[]{1,1});
    sourceCounts(section, "member_limit", new int[]{2,3});
    Map<String,String> original = values(section);
    if (original.size() != 7) throw new AssertionError("Expected 5 people + 2 root-counted answers");
    String originalId = instanceId(section);
    String saved = serialize(section);
    Files.writeString(output.resolve("section-draft.xml"), saved, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
    FormEntryController reloaded = load(xml, saved);
    traverse(reloaded, null, "member_limit", null);
    sectionCounts(reloaded, "section-resumed", new int[]{2,3}, new int[]{1,1});
    sourceCounts(reloaded, "member_limit", new int[]{2,3});
    sourceCounts(reloaded, "root_count", new int[]{1});
    if (!original.equals(values(reloaded))) throw new AssertionError("Section reload changed answers");
    if (!originalId.equals(instanceId(reloaded))) throw new AssertionError("Section instanceID changed on reload");
    System.out.println("section instanceID stable across reload=true");
    traverse(reloaded, new int[]{2,3}, "member_limit", 3);
    sectionCounts(reloaded, "section-root-source-increased", new int[]{2,3}, new int[]{3,3});
    sourceCounts(reloaded, "member_limit", new int[]{2,3});
    sourceCounts(reloaded, "root_count", new int[]{3});
    Map<String,String> beforeReduction = values(reloaded);
    if (beforeReduction.size() != 11) throw new AssertionError("Expected 11 section answers after root count increase");
    traverse(reloaded, new int[]{1,1}, "member_limit", 1, false);
    sectionCounts(reloaded, "section-reduction-retains-existing", new int[]{2,3}, new int[]{3,3});
    sourceCounts(reloaded, "member_limit", new int[]{1,1});
    sourceCounts(reloaded, "root_count", new int[]{1});
    if (!beforeReduction.equals(values(reloaded))) throw new AssertionError("Section reduction changed answers");
    String reducedSaved = serialize(reloaded);
    Files.writeString(output.resolve("section-reduced.xml"), reducedSaved, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
    FormEntryController reducedReload = load(xml, reducedSaved);
    traverse(reducedReload, null, "member_limit", null);
    sectionCounts(reducedReload, "section-reduced-draft-resumed", new int[]{2,3}, new int[]{3,3});
    sourceCounts(reducedReload, "member_limit", new int[]{1,1});
    sourceCounts(reducedReload, "root_count", new int[]{1});
    if (!beforeReduction.equals(values(reducedReload))) throw new AssertionError("Section reduced reload changed answers");
    if (!originalId.equals(instanceId(reducedReload))) throw new AssertionError("Section reduced reload changed ID");
  }
}
